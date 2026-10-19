// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.animation.ValueAnimator
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Rational
import android.view.View
import android.widget.Button
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.annotation.OptIn
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.C
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaController
import androidx.media3.ui.PlayerView
import app.friendflix.android.R
import app.friendflix.android.bridge.PlayRequest
import app.friendflix.android.downloads.Downloads
import app.friendflix.android.downloads.SessionExpired
import app.friendflix.android.offline.Offline
import app.friendflix.android.offline.OfflineActivity
import app.friendflix.android.offline.OfflineMedia
import app.friendflix.android.offline.Prepared
import app.friendflix.android.settings.AppSettings
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * The native player (Media3 / ExoPlayer) for streams and downloads, with the web player's behaviour (progress reports, skip
 * buttons, next-episode card + countdown, "still there?", audio / subtitle / quality choice, resume) and the native extras:
 * picture-in-picture (auto-enter on Home while playing), background audio when the setting is on, a media session for the lock
 * screen, notification and Bluetooth / headset buttons ([PlaybackSession]).
 *
 * Streams: `POST /api/playback/info` with the device's caps ([DeviceProfile]); the server decides direct play vs. HLS and applies role
 * caps, kids rules and the stream limit. Downloads: only an [OfflineMedia] from the offline gate; after a recreation / process
 * death the player keeps just the licence id and asks [Offline.prepare] again. Logs carry no titles, URLs, cookies or tokens.
 */
@OptIn(UnstableApi::class)
class PlayerActivity : ComponentActivity() {
    /** What to play, from the intent or the saved state. */
    private data class Args(
        val itemId: String, val profileId: String, val startMs: Long?, val audio: String?, val subtitle: String?, val licenseId: String?,
    )

    /** One online stream: the session of the playback answer and the choices it was asked with. */
    private class Stream(val api: PlayerApi, val info: PlaybackInfo, val direct: Boolean)

    private lateinit var view: PlayerView
    private lateinit var loading: ProgressBar
    private lateinit var skipButton: Button
    private lateinit var nextCard: LinearLayout
    private lateinit var nextLabel: TextView
    private lateinit var nextTitle: TextView
    private lateinit var nextSeconds: TextView
    private lateinit var nextRing: ProgressBar
    private lateinit var stillCard: LinearLayout
    private lateinit var stillText: TextView
    private lateinit var errorBox: LinearLayout
    private lateinit var errorText: TextView
    private lateinit var errorRetry: Button
    private lateinit var toast: TextView
    private lateinit var title: TextView
    private lateinit var subtitle: TextView
    private lateinit var tracksButton: ImageButton
    private lateinit var qualityButton: Button
    private lateinit var pipButton: ImageButton
    private lateinit var nextButton: ImageButton

    private lateinit var player: ExoPlayer
    private var controller: ListenableFuture<MediaController>? = null
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var args: Args
    private var token: String? = null
    private var loadJob: Job? = null
    private var released = false

    // online
    private var stream: Stream? = null
    private var reporter: PlaybackReporter? = null
    private var api: PlayerApi? = null
    private var prefs = PlayerPrefs()
    private var item: ItemInfo? = null
    private var nextItem: ItemInfo? = null
    private var flow: EpisodeFlow? = null
    private var audioIndex: Int? = null
    /** the viewer's subtitle choice: null = off; the wanted index is applied once the tracks are known */
    private var subIndex: Int? = null
    private var quality = 0L
    private var forcedHls = false
    private var retries = 0
    private var errorAt = 0L
    private var seriesPref: Pair<String?, String?> = null to null
    /** ms the current stream was started at (null before the first one) */
    private var attachedAt: Long? = null

    // offline
    private var offlineLicense: String? = null
    private var offlineProgress: OfflineProgress? = null

    private var backgroundAudio = false
    private var lastTick = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)
        bindViews()
        hideSystemBars()
        val restored = savedInstanceState?.let(::fromState)
        val a = restored ?: fromIntent(intent)
        if (a == null) { finish(); return }
        args = a
        token = if (restored == null) intent.getStringExtra(EXTRA_TOKEN) else savedInstanceState.getString(EXTRA_TOKEN)
        audioIndex = savedInstanceState?.takeIf { it.containsKey(STATE_AUDIO) }?.getInt(STATE_AUDIO)
        quality = savedInstanceState?.getLong(STATE_QUALITY) ?: 0L

        val open = PendingIntent.getActivity(this, 0, Intent(this, PlayerActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        player = PlayerHolder.acquire(this, open)
        view.player = player
        player.addListener(listener)
        controller = PlayerHolder.connect(this) // runs the media session service (notification while playing)
        lifecycleScope.launch { AppSettings.from(applicationContext).backgroundAudio.collect { backgroundAudio = it } }
        ContextCompat.registerReceiver(this, pipReceiver, IntentFilter(ACTION_PIP_TOGGLE), ContextCompat.RECEIVER_NOT_EXPORTED)
        pipButton.visibility = if (pipSupported()) View.VISIBLE else View.GONE

        // a fresh launch takes the gate's media from the launcher; a restore (or a lost hand-off) runs the gate again
        val handed = if (restored == null) token?.let { Handoff.take(it) } else null
        start(args, handed?.offline)
        handler.post(ticker)
    }

    private fun bindViews() {
        view = findViewById(R.id.player_view)
        loading = findViewById(R.id.player_loading)
        skipButton = findViewById(R.id.player_skip)
        nextCard = findViewById(R.id.player_next)
        nextLabel = findViewById(R.id.player_next_label)
        nextTitle = findViewById(R.id.player_next_title)
        nextSeconds = findViewById(R.id.player_next_seconds)
        nextRing = findViewById(R.id.player_next_ring)
        stillCard = findViewById(R.id.player_still)
        stillText = findViewById(R.id.player_still_text)
        errorBox = findViewById(R.id.player_error)
        errorText = findViewById(R.id.player_error_text)
        errorRetry = findViewById(R.id.player_error_retry)
        toast = findViewById(R.id.player_toast)
        title = view.findViewById(R.id.player_title)
        subtitle = view.findViewById(R.id.player_subtitle)
        tracksButton = view.findViewById(R.id.player_tracks)
        qualityButton = view.findViewById(R.id.player_quality)
        pipButton = view.findViewById(R.id.player_pip)
        nextButton = view.findViewById(R.id.player_next_episode)
        view.findViewById<View>(R.id.player_back).setOnClickListener { finish() }
        // Task 9 (Chromecast) wires R.id.player_cast; it stays hidden until then.
        tracksButton.setOnClickListener { showTracks(it) }
        qualityButton.setOnClickListener { showQuality(it) }
        pipButton.setOnClickListener { enterPip() }
        nextButton.setOnClickListener { goNext(flow?.goNow()) }
        skipButton.setOnClickListener { doSkip() }
        findViewById<View>(R.id.player_next_go).setOnClickListener { goNext(flow?.goNow()) }
        findViewById<View>(R.id.player_next_credits).setOnClickListener { flow?.watchCredits(); render() }
        findViewById<View>(R.id.player_still_go).setOnClickListener { goNext(flow?.keepWatching()) }
        findViewById<View>(R.id.player_still_back).setOnClickListener { finish() }
        findViewById<View>(R.id.player_error_back).setOnClickListener { finish() }
        errorRetry.setOnClickListener { retries = 0; hideError(); reload(resumePos()) }
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.player_root)) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(bars.left, 0, bars.right, 0)
            insets
        }
    }

    private fun hideSystemBars() {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    // ---- what to play ----

    private fun start(a: Args, handed: OfflineMedia?) {
        loadJob?.cancel()
        hideError()
        loading.visibility = View.VISIBLE
        if (a.licenseId != null) startOffline(a, handed) else startOnline(a, first = true, startMs = a.startMs)
    }

    private fun startOffline(a: Args, handed: OfflineMedia?) {
        val offline = Offline.get(applicationContext)
        loadJob = lifecycleScope.launch {
            val media = handed?.takeIf { it.licenseId == a.licenseId } ?: when (val p = offline.prepare(a.licenseId!!)) {
                is Prepared.Ready -> p.request.offline!!
                is Prepared.Blocked -> {
                    showError(getString(OfflineActivity.reasonText(p.reason)), retry = false)
                    return@launch
                }
            }
            val keys = try {
                withContext(Dispatchers.IO) { offline.downloads.keys.keys() }
            } catch (_: IOException) {
                showError(getString(R.string.offline_reason_keys), retry = false)
                return@launch
            }
            val record = offline.downloads.store.get(media.licenseId)
            offlineLicense = media.licenseId
            title.text = record?.title.orEmpty()
            subtitle.text = ""
            tracksButton.visibility = if (media.subtitles.isEmpty()) View.GONE else View.VISIBLE
            qualityButton.visibility = View.GONE
            val meta = MediaMetadata.Builder().setTitle(record?.title).build()
            val source = MediaSources.encrypted(keys).createMediaSource(MediaSources.localItem(media.video, media.subtitles, meta))
            player.setMediaSource(source, a.startMs?.takeIf { it > OFFLINE_MIN_RESUME_MS } ?: 0L)
            subIndex = null
            applySubtitles()
            player.prepare()
            player.playWhenReady = true
            offlineProgress = OfflineProgress(
                record = { pos, played -> offline.recordPosition(media.licenseId, pos, played) },
                now = System::currentTimeMillis,
                position = { Position(player.currentPosition, !player.playWhenReady) },
                durationMs = { player.duration.takeIf { it != C.TIME_UNSET } ?: 0L },
            )
            flow = null
        }
    }

    private fun startOnline(a: Args, first: Boolean, startMs: Long?) {
        loadJob = lifecycleScope.launch {
            try {
                val server = Downloads.get(applicationContext).api()
                if (server == null) { showError(getString(R.string.player_error_generic), retry = false); return@launch }
                val pa = PlayerApi(server, a.profileId)
                api = pa
                if (first) loadTitle(pa, a)
                val audioLang = if (audioIndex == null) (a.audio ?: seriesPref.first ?: prefs.audioLang).takeIf { it.isNotEmpty() } else null
                val caps = withContext(Dispatchers.IO) { DeviceProfile.build(applicationContext) }
                val body = PlayerApi.infoBody(a.itemId, startMs, audioIndex, quality.takeIf { it > 0 }, manual = quality > 0, audioLang = audioLang, caps = caps)
                when (val r = withContext(Dispatchers.IO) { pa.info(body) }) {
                    is InfoAnswer.Ok -> attach(pa, r.info, startMs ?: (r.info.resumeTicks / TICKS_PER_MS))
                    is InfoAnswer.MaxStreams -> showError(resources.getQuantityString(R.plurals.player_error_max_streams, r.max, r.max), retry = true)
                    InfoAnswer.Refused -> showError(getString(R.string.player_error_generic), retry = false)
                    InfoAnswer.Retry -> retryLater(startMs)
                }
            } catch (_: SessionExpired) {
                showError(getString(R.string.player_error_signed_out), retry = false)
            }
        }
    }

    /** First start of a title: preferences, item, next episode, segments and the series' language choice, in parallel. */
    private suspend fun loadTitle(pa: PlayerApi, a: Args) = withContext(Dispatchers.IO) {
        val p = async { pa.prefs() }
        val types = async { pa.segmentTypes() }
        val it = async { pa.item(a.itemId) }
        val nx = async { pa.next(a.itemId) }
        val segs = async { pa.segments(a.itemId) }
        prefs = p.await()
        if (quality == 0L && prefs.quality >= MIN_BITRATE) quality = prefs.quality
        val cur = it.await()
        item = cur
        seriesPref = if (cur?.type == "Episode") pa.langPref(cur.seriesId ?: a.itemId) else null to null
        val next: ItemInfo? = if (cur?.type == "Episode") nx.await() else { nx.cancel(); null }
        nextItem = next
        val allowed = types.await()
        val f = EpisodeFlow(segs.await().filter { s -> s.type in allowed }, NextKind.of(cur?.type, next != null), prefs.flow, Players.still)
        withContext(Dispatchers.Main) {
            flow = f
            Players.still.opened()
            title.text = cur?.seriesName ?: cur?.name.orEmpty()
            subtitle.text = cur?.let { i -> if (i.seriesName != null) episodeLabel(i) else "" }.orEmpty()
            nextButton.visibility = if (next != null) View.VISIBLE else View.GONE
        }
    }

    private fun attach(pa: PlayerApi, info: PlaybackInfo, startMs: Long) {
        // an audio track the server baked into the HLS stream (audioLang matched another track) means HLS, like the web player
        if (info.audioIndex != null) audioIndex = info.audioIndex
        val direct = info.directUrl != null && audioIndex == null && !forcedHls
        val url = pa.server.resolve(if (direct) info.directUrl!! else info.hlsUrl)
        if (url == null) { showError(getString(R.string.player_error_generic), retry = false); return } // never another host
        val subs = info.subtitles.mapNotNull { s ->
            pa.server.resolve(s.url)?.let { MediaSources.webVtt(it.toString().toUri(), s.index, s.language, s.title) }
        }
        val cur = item
        val meta = MediaMetadata.Builder()
            .setTitle(cur?.seriesName ?: cur?.name)
            .setArtist(cur?.takeIf { it.seriesName != null }?.let(::episodeLabel))
            .build()
        val mediaItem = MediaSources.streamItem(url.toString().toUri(), hls = !direct, subtitles = subs, meta = meta)
        // paused while the new stream is set up, so that starting it is a play event (the reporter's `start` of this session)
        player.playWhenReady = false
        stream = Stream(pa, info, direct)
        attachedAt = startMs.coerceAtLeast(0)
        val rep = PlaybackReporter(
            send = { kind, body -> Players.reports.execute { pa.report(kind, body) } },
            now = System::currentTimeMillis,
            position = { Position(player.currentPosition.coerceAtLeast(0), !player.playWhenReady) },
        )
        reporter = rep
        rep.attach(ReportSession(args.itemId, info.playSessionId, info.mediaSourceId, audioIndex, direct))
        subIndex = pickSubtitle(info)
        player.setMediaSource(MediaSources.network(pa.server.client).createMediaSource(mediaItem), startMs.coerceAtLeast(0))
        applySubtitles()
        player.prepare()
        player.playWhenReady = true
        tracksButton.visibility = if (info.audioTracks.size > 1 || info.subtitles.isNotEmpty()) View.VISIBLE else View.GONE
        qualityButton.visibility = View.VISIBLE
        qualityButton.text = if (direct) getString(R.string.player_quality_original) else qualityLabel(quality)
        flow?.duration = 0.0
    }

    /** detail-page pick > this series' saved choice (when the episode has it) > the profile default (web Player.svelte attach). */
    private fun pickSubtitle(info: PlaybackInfo): Int? {
        val want = when {
            args.subtitle == "off" -> null
            args.subtitle != null -> args.subtitle
            seriesPref.second == "off" -> null
            seriesPref.second != null && info.subtitles.any { it.language == seriesPref.second } -> seriesPref.second
            else -> prefs.subtitleLang.takeIf { it.isNotEmpty() }
        } ?: return null
        return info.subtitles.firstOrNull { it.language == want }?.index
    }

    /**
     * Where a new session should start: the current position once this stream played, else where it was started (a retry before
     * the first frame must not restart at 0 or overwrite the server's resume point); null = the server's resume point.
     */
    private fun resumePos(): Long? {
        val p = player.currentPosition
        return if (stream != null && p > 0) p else attachedAt ?: args.startMs
    }

    /** A new playback session at [positionMs] (retry, audio track, quality): the old one is reported stopped first. */
    private fun reload(positionMs: Long?) {
        reporter?.switchStream()
        if (offlineLicense != null) { start(args.copy(startMs = positionMs), null); return }
        loading.visibility = View.VISIBLE
        startOnline(args, first = false, startMs = positionMs)
    }

    private fun retryLater(positionMs: Long?) {
        if (retries >= MAX_RETRIES) { showError(getString(R.string.player_error_connection), retry = true); return }
        retries++
        errorAt = positionMs ?: 0L
        flash(getString(R.string.player_reconnecting), RETRY_BASE_MS * (1L shl (retries - 1)))
        loadJob = lifecycleScope.launch {
            delay(RETRY_BASE_MS * (1L shl (retries - 1)))
            reload(positionMs)
        }
    }

    // ---- player events ----

    private val listener = object : Player.Listener {
        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            if (playWhenReady) reporter?.onPlay() else { reporter?.onPause(); offlineProgress?.flush() }
            updatePip()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) { updatePip() }

        override fun onPlaybackStateChanged(state: Int) {
            loading.visibility = if (state == Player.STATE_BUFFERING && player.playWhenReady && errorBox.visibility != View.VISIBLE) View.VISIBLE else View.GONE
            if (state == Player.STATE_READY) flow?.duration = player.duration.takeIf { it != C.TIME_UNSET }?.let { it / 1000.0 } ?: 0.0
            if (state == Player.STATE_ENDED) {
                reporter?.onEnded()
                offlineProgress?.flush()
                flow?.onEnded()
                render()
            }
        }

        override fun onPositionDiscontinuity(old: Player.PositionInfo, new: Player.PositionInfo, reason: Int) {
            if (reason == Player.DISCONTINUITY_REASON_SEEK) { reporter?.onSeeked(); offlineProgress?.flush() }
        }

        override fun onTracksChanged(tracks: Tracks) { applySubtitles() }

        override fun onVideoSizeChanged(videoSize: VideoSize) { updatePip() }

        override fun onPlayerError(error: PlaybackException) { onError(error) }
    }

    private fun onError(error: PlaybackException) {
        val pos = resumePos()
        Log.w(TAG, "playback error ${error.errorCodeName}")
        val lic = offlineLicense
        if (lic != null) {
            if (generateSequence(error as Throwable) { it.cause }.any { it is IOException && (it.message == "integrity" || it.message == "incomplete") }) {
                Downloads.get(applicationContext).queue.redownload(lic) // damaged file: fetched again when online
            }
            showError(getString(R.string.player_error_connection), retry = false)
            return
        }
        val s = stream
        val code = error.errorCode
        if (s != null && s.direct && !forcedHls && code >= PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED && code < PlaybackException.ERROR_CODE_DRM_UNSPECIFIED) {
            // the device could not decode / parse the direct file after all: the server's HLS (transcode) instead, like the web
            forcedHls = true
            flash(getString(R.string.player_switching_transcode), 2_500)
            reload(pos)
            return
        }
        if (code in PlaybackException.ERROR_CODE_IO_UNSPECIFIED until PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED ||
            code == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW || code == PlaybackException.ERROR_CODE_TIMEOUT
        ) {
            retryLater(pos)
            return
        }
        showError(getString(R.string.player_error_connection), retry = true)
    }

    // ---- the 250 ms tick: reports, skip button, next-up card ----

    private val ticker = object : Runnable {
        override fun run() {
            if (released) return
            tick()
            handler.postDelayed(this, TICK_MS)
        }
    }

    private fun tick() {
        val now = android.os.SystemClock.elapsedRealtime()
        val dt = if (lastTick == 0L) 0L else now - lastTick
        lastTick = now
        reporter?.tick()
        offlineProgress?.tick()
        if (retries > 0 && player.isPlaying && player.currentPosition > errorAt + STABLE_MS) {
            if (retries > 0) flash(getString(R.string.player_reconnected), 1_500)
            retries = 0
        }
        val f = flow ?: run { skipButton.visibility = View.GONE; nextCard.visibility = View.GONE; stillCard.visibility = View.GONE; return }
        val cur = player.currentPosition / 1000.0
        f.autoSkip(cur)?.let { target ->
            player.seekTo((target * 1000).toLong())
            flash(getString(R.string.player_skipped_intro), 1_500)
        }
        val step = f.update(cur, player.isPlaying, player.playbackState == Player.STATE_ENDED, dt)
        if (step.goNext) { goNext(step); return }
        render(step.card)
    }

    private fun render(card: FlowCard? = null) {
        val f = flow
        val inPip = isInPip()
        val c = card ?: f?.update(player.currentPosition / 1000.0, player.isPlaying, player.playbackState == Player.STATE_ENDED, 0)?.card ?: FlowCard.Hidden
        val skip = f?.skip(player.currentPosition / 1000.0)
        if (skip != null && !inPip && errorBox.visibility != View.VISIBLE) {
            skipButton.text = getString(skipText(skip.type))
            skipButton.visibility = View.VISIBLE
        } else {
            skipButton.visibility = View.GONE
        }
        val next = nextItem
        stillCard.visibility = if (c == FlowCard.StillThere && next != null && !inPip) View.VISIBLE else View.GONE
        if (c == FlowCard.StillThere && next != null) stillText.text = getString(R.string.player_still_text, episodeLabel(next))
        if (c is FlowCard.NextUp && next != null && !inPip) {
            nextCard.visibility = View.VISIBLE
            nextTitle.text = episodeLabel(next)
            nextLabel.text = if (c.counting) getString(R.string.player_next_counting, c.secondsLeft) else getString(R.string.player_next)
            nextSeconds.text = if (c.counting) c.secondsLeft.toString() else ""
            // reduced motion (animations off): the number only, no moving ring
            val ring = c.counting && ValueAnimator.areAnimatorsEnabled()
            nextRing.visibility = if (ring) View.VISIBLE else View.INVISIBLE
            if (ring) nextRing.progress = ((EpisodeFlow.COUNTDOWN_MS - c.secondsLeft * 1000L).coerceIn(0, EpisodeFlow.COUNTDOWN_MS)).toInt()
            nextCard.stateDescriptionCompat(if (c.counting) resources.getQuantityString(R.plurals.player_starts_in, c.secondsLeft, c.secondsLeft) else null)
        } else {
            nextCard.visibility = View.GONE
        }
    }

    private fun View.stateDescriptionCompat(text: String?) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) stateDescription = text
    }

    private fun doSkip() {
        val f = flow ?: return
        val s = f.skip(player.currentPosition / 1000.0) ?: return
        if (f.skipGoesNext(s, nextItem != null)) { goNext(f.goNow()); return }
        player.seekTo((s.endSec * 1000).toLong())
    }

    /** The next episode in this player (web: the watch page replaces itself; one Back leaves the player). */
    private fun goNext(step: EpisodeStep?) {
        if (step == null || !step.goNext) return
        val next = nextItem ?: return
        reporter?.release()
        reporter = null
        stream = null
        attachedAt = null
        flow = null
        nextItem = null
        audioIndex = null
        forcedHls = false
        retries = 0
        player.stop()
        nextCard.visibility = View.GONE
        stillCard.visibility = View.GONE
        args = args.copy(itemId = next.id, startMs = null)
        loading.visibility = View.VISIBLE
        startOnline(args, first = true, startMs = null)
    }

    // ---- audio / subtitles / quality ----

    private fun showTracks(anchor: View) {
        Players.still.noteInteraction()
        val menu = PopupMenu(this, anchor)
        val s = stream
        if (s != null && s.info.audioTracks.size > 1) {
            val audio = menu.menu.addSubMenu(0, 0, 0, R.string.player_audio)
            val current = audioIndex ?: s.info.audioTracks.firstOrNull { it.isDefault }?.index
            for (t in s.info.audioTracks) {
                audio.add(GROUP_AUDIO, t.index, 0, t.title).setCheckable(true).setChecked(t.index == current).setOnMenuItemClickListener { changeAudio(t); true }
            }
            audio.setGroupCheckable(GROUP_AUDIO, true, true)
        }
        val subs = menu.menu.addSubMenu(0, 1, 1, R.string.player_subtitles)
        subs.add(GROUP_SUBS, OFF, 0, R.string.player_subtitles_off).setCheckable(true).setChecked(subIndex == null).setOnMenuItemClickListener { setSubtitle(null, null); true }
        if (s != null) {
            for (t in s.info.subtitles) {
                subs.add(GROUP_SUBS, t.index, 0, t.title).setCheckable(true).setChecked(subIndex == t.index).setOnMenuItemClickListener { setSubtitle(t.index, t.language); true }
            }
        } else {
            val media = Offline.get(applicationContext).downloads.store.get(offlineLicense ?: "")?.subtitles.orEmpty()
            media.forEachIndexed { i, t -> subs.add(GROUP_SUBS, i, 0, t.lang).setCheckable(true).setChecked(subIndex == i).setOnMenuItemClickListener { setSubtitle(i, null); true } }
        }
        subs.setGroupCheckable(GROUP_SUBS, true, true)
        menu.show()
    }

    private fun changeAudio(t: AudioTrack) {
        if (t.index == audioIndex) return
        rememberLang(audio = t.language)
        audioIndex = t.index
        reload(resumePos())
    }

    private fun setSubtitle(index: Int?, language: String?) {
        subIndex = index
        applySubtitles()
        if (stream != null) rememberLang(subtitle = if (index == null) "off" else language)
    }

    private fun rememberLang(audio: String? = null, subtitle: String? = null) {
        val series = item?.seriesId ?: return
        val pa = api ?: return
        if ((audio ?: subtitle).isNullOrEmpty() || audio == "und" || subtitle == "und") return
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) { pa.saveLangPref(series, audio, subtitle) }
            if (ok) flash(getString(R.string.player_lang_saved), 1_400)
        }
    }

    /** Shows exactly the chosen side-loaded subtitle (id `sub-<index>`), or none. */
    private fun applySubtitles() {
        val b = player.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_TEXT)
        val want = subIndex
        if (want == null) {
            b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        } else {
            val id = MediaSources.subtitleId(want)
            val group = player.currentTracks.groups.firstOrNull { g ->
                g.type == C.TRACK_TYPE_TEXT && (0 until g.length).any { g.getTrackFormat(it).id?.endsWith(id) == true }
            }
            if (group == null) return // not known yet: applied again on onTracksChanged
            val i = (0 until group.length).first { group.getTrackFormat(it).id?.endsWith(id) == true }
            b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false).setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, i))
        }
        val p = b.build()
        if (p != player.trackSelectionParameters) player.trackSelectionParameters = p
    }

    private fun showQuality(anchor: View) {
        Players.still.noteInteraction()
        val s = stream ?: return
        val menu = PopupMenu(this, anchor)
        val rungs = QUALITIES.filter { (_, bps) -> s.info.roleMaxBitrate == null || bps < s.info.roleMaxBitrate }
        menu.menu.add(GROUP_QUALITY, 0, 0, R.string.player_quality_auto).setCheckable(true).setChecked(quality == 0L).setOnMenuItemClickListener { changeQuality(0); true }
        rungs.forEachIndexed { i, (label, bps) ->
            menu.menu.add(GROUP_QUALITY, i + 1, i + 1, label).setCheckable(true).setChecked(quality == bps).setOnMenuItemClickListener { changeQuality(bps); true }
        }
        menu.menu.setGroupCheckable(GROUP_QUALITY, true, true)
        menu.show()
    }

    private fun changeQuality(bps: Long) {
        if (bps == quality) return
        quality = bps
        reload(resumePos())
        flash(getString(R.string.player_quality_changed, qualityLabel(bps)), 1_100)
    }

    private fun qualityLabel(bps: Long) = QUALITIES.firstOrNull { it.second == bps }?.first ?: getString(R.string.player_quality_auto)

    // ---- picture-in-picture, background ----

    private fun pipSupported() = packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    private fun isInPip() = isInPictureInPictureMode

    private fun pipParams(): PictureInPictureParams {
        val b = PictureInPictureParams.Builder()
        val v = player.videoSize
        if (v.width > 0 && v.height > 0) {
            val r = (v.width * v.pixelWidthHeightRatio / v.height).coerceIn(PIP_MIN_RATIO, PIP_MAX_RATIO)
            b.setAspectRatio(Rational((r * 1000).toInt(), 1000))
        }
        val playing = player.playWhenReady
        val action = RemoteAction(
            Icon.createWithResource(this, if (playing) R.drawable.ic_player_pause else R.drawable.ic_player_play),
            getString(if (playing) R.string.player_pause else R.string.player_play),
            getString(if (playing) R.string.player_pause else R.string.player_play),
            PendingIntent.getBroadcast(this, 0, Intent(ACTION_PIP_TOGGLE).setPackage(packageName), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
        )
        b.setActions(listOf(action))
        // the video's on-screen bounds: the system animates from there into the window
        val hint = android.graphics.Rect()
        if (view.videoSurfaceView?.getGlobalVisibleRect(hint) == true && !hint.isEmpty) b.setSourceRectHint(hint)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) b.setAutoEnterEnabled(player.isPlaying && errorBox.visibility != View.VISIBLE).setSeamlessResizeEnabled(true)
        return b.build()
    }

    private fun updatePip() {
        if (!pipSupported() || released) return
        try { setPictureInPictureParams(pipParams()) } catch (_: IllegalStateException) { }
    }

    private fun enterPip() {
        if (!pipSupported()) return
        try { enterPictureInPictureMode(pipParams()) } catch (_: IllegalStateException) { }
    }

    private val pipReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == ACTION_PIP_TOGGLE) player.playWhenReady = !player.playWhenReady
        }
    }

    /** Home while playing on Android < 12 (12+ enters by itself, setAutoEnterEnabled). */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && player.isPlaying) enterPip()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        view.useController = !isInPictureInPictureMode
        if (isInPictureInPictureMode) view.hideController()
        render()
        // the picture-in-picture window was closed (not expanded): playback ends with it
        if (!isInPictureInPictureMode && !lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) finish()
    }

    override fun onStop() {
        super.onStop()
        if (isChangingConfigurations || released) return
        reporter?.onBackground()
        offlineProgress?.flush()
        // background audio only with the setting on; picture-in-picture keeps playing anyway
        if (!isInPictureInPictureMode && !backgroundAudio) player.pause()
    }

    // ---- viewer activity (still watching) ----

    /** Any touch, key or remote button on the player screen. */
    override fun onUserInteraction() {
        super.onUserInteraction()
        Players.still.noteInteraction()
    }

    // ---- intents, state, release ----

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val a = fromIntent(intent) ?: return // the notification / session activity: just show the player again
        val t = intent.getStringExtra(EXTRA_TOKEN)
        val handed = t?.let { Handoff.take(it) }
        if (t == token) return
        token?.let { Players.launcher?.ended(it) }
        token = t
        reporter?.release()
        reporter = null
        offlineProgress?.flush()
        offlineProgress = null
        offlineLicense = null
        stream = null
        attachedAt = null
        flow = null
        nextItem = null
        audioIndex = null
        forcedHls = false
        retries = 0
        player.stop()
        args = a
        start(a, handed?.offline)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (!::args.isInitialized) return
        outState.putString(EXTRA_ITEM, args.itemId)
        outState.putString(EXTRA_PROFILE, args.profileId)
        outState.putLong(EXTRA_START, player.currentPosition.coerceAtLeast(0))
        args.audio?.let { outState.putString(EXTRA_AUDIO, it) }
        args.subtitle?.let { outState.putString(EXTRA_SUB, it) }
        // a download keeps only its licence id: the restored player asks the offline gate again
        args.licenseId?.let { outState.putString(EXTRA_LICENSE, it) }
        outState.putString(EXTRA_TOKEN, token)
        audioIndex?.let { outState.putInt(STATE_AUDIO, it) }
        outState.putLong(STATE_QUALITY, quality)
    }

    override fun finish() {
        releaseAll()
        super.finish()
    }

    override fun onDestroy() {
        releaseAll()
        try { unregisterReceiver(pipReceiver) } catch (_: IllegalArgumentException) { }
        super.onDestroy()
    }

    /** Stop report, offline position, player, session and service; the launcher may start this title again. */
    private fun releaseAll() {
        if (released || !::player.isInitialized) return
        released = true
        handler.removeCallbacksAndMessages(null)
        loadJob?.cancel()
        reporter?.release()
        offlineProgress?.flush()
        player.removeListener(listener)
        view.player = null
        controller?.let { MediaController.releaseFuture(it) }
        controller = null
        PlayerHolder.release()
        PlaybackSession.stop(applicationContext)
        token?.let { Players.launcher?.ended(it) }
    }

    private fun showError(text: String, retry: Boolean) {
        loading.visibility = View.GONE
        errorText.text = text
        errorRetry.visibility = if (retry) View.VISIBLE else View.GONE
        errorBox.visibility = View.VISIBLE
        skipButton.visibility = View.GONE
        nextCard.visibility = View.GONE
        stillCard.visibility = View.GONE
        updatePip()
    }

    private fun hideError() { errorBox.visibility = View.GONE }

    private fun flash(text: String, ms: Long) {
        toast.text = text
        toast.visibility = View.VISIBLE
        toast.removeCallbacks(hideToast)
        toast.postDelayed(hideToast, ms)
    }

    private val hideToast = Runnable { toast.visibility = View.GONE }

    private fun episodeLabel(i: ItemInfo): String {
        val code = if (i.season != null && i.episode != null) getString(R.string.player_episode_code, i.season, i.episode) else ""
        return listOf(code, i.name).filter { it.isNotEmpty() }.joinToString(" · ")
    }

    private fun skipText(type: String) = when (type) {
        "intro" -> R.string.player_skip_intro
        "outro" -> R.string.player_skip_outro
        "recap" -> R.string.player_skip_recap
        else -> R.string.player_skip_preview
    }

    private fun fromIntent(i: Intent): Args? {
        val item = i.getStringExtra(EXTRA_ITEM) ?: return null
        val profile = i.getStringExtra(EXTRA_PROFILE) ?: return null
        val start = i.getLongExtra(EXTRA_START, -1).takeIf { it >= 0 }
        return Args(item, profile, start, i.getStringExtra(EXTRA_AUDIO), i.getStringExtra(EXTRA_SUB), i.getStringExtra(EXTRA_LICENSE))
    }

    private fun fromState(b: Bundle): Args? {
        val item = b.getString(EXTRA_ITEM) ?: return null
        val profile = b.getString(EXTRA_PROFILE) ?: return null
        return Args(item, profile, b.getLong(EXTRA_START, 0).takeIf { it > 0 }, b.getString(EXTRA_AUDIO), b.getString(EXTRA_SUB), b.getString(EXTRA_LICENSE))
    }

    /**
     * In-memory hand-over from the launcher to the activity it starts (the offline gate's [OfflineMedia] cannot travel in an
     * intent). Entries are taken once; a restored activity finds none and runs the gate again.
     */
    object Handoff {
        private val pending = ConcurrentHashMap<String, PlayRequest>()

        fun put(token: String, req: PlayRequest) {
            if (pending.size > MAX_PENDING) pending.clear()
            pending[token] = req
        }

        fun take(token: String): PlayRequest? = pending.remove(token)

        private const val MAX_PENDING = 8
    }

    companion object {
        private const val TAG = "FFPlayer"
        const val EXTRA_ITEM = "app.friendflix.android.player.ITEM"
        const val EXTRA_PROFILE = "app.friendflix.android.player.PROFILE"
        const val EXTRA_START = "app.friendflix.android.player.START"
        const val EXTRA_AUDIO = "app.friendflix.android.player.AUDIO"
        const val EXTRA_SUB = "app.friendflix.android.player.SUB"
        const val EXTRA_LICENSE = "app.friendflix.android.player.LICENSE"
        const val EXTRA_TOKEN = "app.friendflix.android.player.TOKEN"
        private const val STATE_AUDIO = "audioIndex"
        private const val STATE_QUALITY = "quality"
        private const val ACTION_PIP_TOGGLE = "app.friendflix.android.player.PIP_TOGGLE"
        private const val TICK_MS = 250L
        private const val TICKS_PER_MS = 10_000L
        private const val MAX_RETRIES = 3
        private const val RETRY_BASE_MS = 1_000L
        /** playing this far past the error position: the error budget starts over (web freshRecovery) */
        private const val STABLE_MS = 8_000L
        private const val MIN_BITRATE = 300_000L
        /** the web OfflinePlayer resumes only past 5 s */
        private const val OFFLINE_MIN_RESUME_MS = 5_000L
        private const val PIP_MIN_RATIO = 0.42f
        private const val PIP_MAX_RATIO = 2.39f
        private const val GROUP_AUDIO = 1
        private const val GROUP_SUBS = 2
        private const val GROUP_QUALITY = 3
        private const val OFF = 10_000
        /** web lib/player/abr.ts LADDER (finite rungs) */
        private val QUALITIES = listOf("1080p" to 8_000_000L, "720p" to 4_000_000L, "480p" to 1_500_000L, "360p" to 800_000L)

        fun intent(context: Context, req: PlayRequest, token: String): Intent = Intent(context, PlayerActivity::class.java)
            .putExtra(EXTRA_ITEM, req.itemId)
            .putExtra(EXTRA_PROFILE, req.profileId)
            .putExtra(EXTRA_TOKEN, token)
            .apply {
                req.startMs?.let { putExtra(EXTRA_START, it) }
                req.audio?.let { putExtra(EXTRA_AUDIO, it) }
                req.subtitle?.let { putExtra(EXTRA_SUB, it) }
                req.offline?.let { putExtra(EXTRA_LICENSE, it.licenseId) }
            }
    }
}

/** Process-wide player state shared across player screens. */
object Players {
    /** "still watching" across episodes and player screens (the web keeps it per tab) */
    val still = StillWatching(System::currentTimeMillis)
    /** progress reports leave in order on one thread and outlive the screen (the stop report is sent after it closed) */
    val reports = Executors.newSingleThreadExecutor { r -> Thread(r, "ff-playback-reports").apply { isDaemon = true } }
    /** the app's launcher (set by the shell) */
    @Volatile var launcher: NativePlayerLauncher? = null
}
