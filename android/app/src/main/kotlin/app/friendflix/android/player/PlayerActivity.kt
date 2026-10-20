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
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.enableEdgeToEdge
import androidx.annotation.OptIn
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.fragment.app.FragmentActivity
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
import androidx.mediarouter.app.MediaRouteButton
import app.friendflix.android.R
import app.friendflix.android.bridge.PlayRequest
import app.friendflix.android.cast.CastConfig
import app.friendflix.android.cast.CastController
import app.friendflix.android.cast.CastHost
import app.friendflix.android.cast.CastServer
import app.friendflix.android.cast.CastServerApi
import app.friendflix.android.cast.CastStart
import app.friendflix.android.cast.IdleReason
import app.friendflix.android.cast.MediaThreeReceiver
import app.friendflix.android.cast.ReceiverState
import app.friendflix.android.cast.TokenAnswer
import app.friendflix.android.downloads.Downloads
import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.downloads.SessionExpired
import app.friendflix.android.offline.Offline
import app.friendflix.android.offline.OfflineActivity
import app.friendflix.android.offline.OfflineMedia
import app.friendflix.android.offline.Prepared
import app.friendflix.android.player.panels.EpisodesPanel
import app.friendflix.android.player.panels.EpisodesSource
import app.friendflix.android.player.panels.SubtitleSearchPanel
import app.friendflix.android.player.panels.TracksActions
import app.friendflix.android.player.panels.TracksState
import app.friendflix.android.settings.AppSettings
import app.friendflix.android.shell.ShellActivity
import app.friendflix.android.shell.ShellIntents
import com.google.android.gms.cast.framework.CastButtonFactory
import com.google.android.gms.cast.framework.CastContext
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
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
 *
 * The bar's panels (Tracks, More with speed, quality, sleep timer, lock, picture-in-picture, Play on TV), the quality chip and the
 * lock live in [PlayerControls]; this screen supplies the playback side ([controlsHost]).
 *
 * Chromecast ([CastController], Task 9): the Cast button shows for a stream (never a download) while the server offers casting and a
 * Cast device is on the network. Picking a device hands the title over through the server's cast token flow; the screen is then the
 * receiver's remote (the controls drive [MediaThreeReceiver.player]) and only the controller reports. When the cast ends, local
 * playback continues at the receiver's position. A FragmentActivity because the Cast device dialog is a dialog fragment.
 */
@OptIn(UnstableApi::class)
class PlayerActivity : FragmentActivity() {
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
    private lateinit var nextButton: ImageButton
    private lateinit var castButton: MediaRouteButton
    private lateinit var castStatus: TextView

    private lateinit var player: ExoPlayer
    private lateinit var controls: PlayerControls
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
    private var serverCaps = ServerCaps()
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
    /** the title's start languages (detail pick, series choice, anime default, profile defaults); set by [loadTitle] */
    private var langs: TitleLangs? = null
    /** ms the current stream was started at (null before the first one) */
    private var attachedAt: Long? = null

    // offline
    private var offlineLicense: String? = null
    private var offlineProgress: OfflineProgress? = null

    private var backgroundAudio = false
    /** the sound mode of the Tracks panel's switches, on the player's audio session through [fx] */
    private var fxMode = "off"
    /** the viewer flipped a switch here: the server's mode no longer replaces it (web fxTouched) */
    private var fxTouched = false
    private val fx = AudioFxAttach()
    private var lastTick = 0L
    /** the screen is stopped and not in picture-in-picture */
    private var inBackground = false
    /** elapsedRealtime when playback was paused (null while playing) */
    private var pausedAt: Long? = null
    private var verifying = false
    /** languages of the download's subtitles (index = track) */
    private var offlineSubLangs: List<String> = emptyList()

    /** the panels' image loader for the server it was made for */
    private var images: Pair<ServerApi, ImageLoader>? = null

    // Chromecast
    private var castLink: MediaThreeReceiver? = null
    /** the cast endpoints for the playing profile (read on the report thread) */
    @Volatile private var castServer: CastServer? = null
    private var cast: CastController? = null
    /** the server offers casting (cached, then the fresh `/api/cast/config` answer) */
    private var castEnabled = false
    /** a Cast device is on the network */
    private var castDevices = false
    /** the next local stream starts paused (back from a paused TV) */
    private var startPaused = false

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)
        bindViews()
        hideSystemBars()
        val restored = savedInstanceState?.let(::fromState)
        token = if (restored == null) intent.getStringExtra(EXTRA_TOKEN) else savedInstanceState.getString(EXTRA_TOKEN)
        val a = restored ?: fromIntent(intent)
        if (a == null) { finish(); return }
        args = a
        audioIndex = savedInstanceState?.takeIf { it.containsKey(STATE_AUDIO) }?.getInt(STATE_AUDIO)
        quality = savedInstanceState?.getLong(STATE_QUALITY) ?: 0L

        val open = PendingIntent.getActivity(this, 0, Intent(this, PlayerActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        PlayerReset.listen(closeOnReset) // signed out of this device / another server: this screen closes like a normal close
        player = PlayerHolder.acquire(this, open)
        view.player = player
        player.addListener(events)
        player.addListener(listener)
        controls = PlayerControls(this, view, player, controlsHost)
        view.subtitleView?.let { applyCaptionLook(it, prefs.subtitleStyle) }
        // the last mode of this profile on this device (offline playback has no server prefs); the server's replaces it once loaded
        setFx(FxStore.load(this, args.profileId))
        // the media session (notification, lock screen, Bluetooth) may start playback only while it could be heard by choice
        PlayerHolder.mayPlay = { !inBackground || backgroundAudio || isInPictureInPictureMode }
        controller = PlayerHolder.connect(this) // runs the media session service (notification while playing)
        lifecycleScope.launch { AppSettings.from(applicationContext).backgroundAudio.collect { backgroundAudio = it } }
        ContextCompat.registerReceiver(this, pipReceiver, IntentFilter(ACTION_PIP_TOGGLE), ContextCompat.RECEIVER_NOT_EXPORTED)
        lifecycleScope.launch {
            castEnabled = AppSettings.from(applicationContext).castEnabled.first()
            updateCastButton()
        }
        setUpCast()

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
        nextButton = view.findViewById(R.id.player_next_episode)
        view.findViewById<View>(R.id.player_back).setOnClickListener { finish() }
        castButton = view.findViewById(R.id.player_cast)
        castStatus = findViewById(R.id.player_cast_status)
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
            val record = withContext(Dispatchers.IO) { offline.downloads.store.get(media.licenseId) }
            offlineLicense = media.licenseId
            offlineSubLangs = media.subtitles.map { it.first }
            title.text = record?.title.orEmpty()
            subtitle.text = ""
            tracksButton.visibility = View.VISIBLE // subtitles and the sound switches
            controls.showEpisodesButton(false) // a download: nothing from the server
            controls.chip.hide()
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
                castServer = CastServerApi(server, a.profileId, pa)
                if (first) loadTitle(pa, a)
                val audioLang = if (audioIndex == null) titleLangs(a).audioLang() else null
                val caps = withContext(Dispatchers.IO) { DeviceProfile.build(applicationContext) }
                val body = PlayerApi.infoBody(a.itemId, startMs, audioIndex, quality.takeIf { it > 0 }, manual = quality > 0, audioLang = audioLang, caps = caps)
                when (val r = withContext(Dispatchers.IO) { pa.info(body) }) {
                    is InfoAnswer.Ok -> attach(pa, r.info, startMs ?: (r.info.resumeTicks / TICKS_PER_MS))
                    is InfoAnswer.MaxStreams -> showError(resources.getQuantityString(R.plurals.player_error_max_streams, r.max, r.max), retry = true)
                    InfoAnswer.Refused -> showError(getString(R.string.player_error_generic), retry = false)
                    InfoAnswer.ProfileMismatch -> openInWeb(a, startMs)
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
        val castCfg = async { CastServerApi.config(pa.server, a.profileId) }
        val capsJob = async { pa.caps() }
        prefs = p.await()
        serverCaps = capsJob.await()
        if (quality == 0L && prefs.quality >= MIN_BITRATE) quality = prefs.quality
        val cur = it.await()
        item = cur
        val pref = if (cur?.type == "Episode") pa.langPref(cur.seriesId ?: a.itemId, anime = prefs.animeOriginal) else LangPref(null, null, false)
        langs = TitleLangs(prefs, pref, TitleLangs.appLang(resources.configuration.locales[0]), a.audio, a.subtitle)
        val next: ItemInfo? = if (cur?.type == "Episode") nx.await() else { nx.cancel(); null }
        nextItem = next
        val allowed = types.await()
        val f = EpisodeFlow(segs.await().filter { s -> s.type in allowed }, NextKind.of(cur?.type, next != null), prefs.flow, Players.still)
        val cfg = castCfg.await()
        // the receiver app id is cached for the Cast framework's next start (it reads its options once per process)
        if (cfg != null) {
            try { AppSettings.from(applicationContext).setCastConfig(cfg.enabled, cfg.receiverAppId) } catch (_: IOException) { }
        }
        withContext(Dispatchers.Main) {
            flow = f
            if (cfg != null) { castEnabled = cfg.enabled; updateCastButton() }
            view.subtitleView?.let { v -> applyCaptionLook(v, prefs.subtitleStyle) }
            if (!fxTouched) setFx(prefs.audioFx) // the server's mode wins until a switch is flipped here (web adoptFxPref)
            Players.still.opened()
            title.text = cur?.seriesName ?: cur?.name.orEmpty()
            subtitle.text = cur?.let { i -> if (i.seriesName != null) episodeLabel(i) else "" }.orEmpty()
            nextButton.visibility = if (next != null) View.VISIBLE else View.GONE
            controls.showEpisodesButton(EpisodesPanel.offered(cur?.type, cur?.seriesId, offline = false))
            controls.loadTitleExtras(pa, a.itemId, serverCaps.chapters) // Scenes, bookmarks and their marks
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
        subIndex = titleLangs(args).subtitle(info, audioIndex)
        player.setMediaSource(MediaSources.network(pa.server.client).createMediaSource(mediaItem), startMs.coerceAtLeast(0))
        applySubtitles()
        player.prepare()
        player.playWhenReady = !startPaused
        startPaused = false
        tracksButton.visibility = View.VISIBLE // audio, subtitles and the sound switches
        controls.chip.bind(direct, info.maxBitrate.takeIf { it > 0 } ?: quality, info.transcodeReason)
        controls.setTrickplay(info.trickplay.takeIf { serverCaps.trickplay })
        flow?.duration = 0.0
        updateCastButton()
    }

    /** the languages of [loadTitle], or the detail pick and profile defaults when the title's start was not loaded here */
    private fun titleLangs(a: Args) = langs ?: TitleLangs(prefs, LangPref(null, null, false), TitleLangs.appLang(resources.configuration.locales[0]), a.audio, a.subtitle)

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

    /** progress reports (shared with the tests, which drive it with a real ExoPlayer) */
    private val events = PlaybackEvents(
        reporter = { reporter },
        offline = { offlineProgress },
        onPlayRequested = ::checkOfflineAfterLongPause,
        onEnded = { flow?.onEnded(); controls.titleEnded(); render() },
    )

    private val listener = object : Player.Listener {
        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            if (!playWhenReady && pausedAt == null) pausedAt = android.os.SystemClock.elapsedRealtime()
            updatePip()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) { updatePip() }

        override fun onPlaybackStateChanged(state: Int) {
            loading.visibility = if (state == Player.STATE_BUFFERING && player.playWhenReady && errorBox.visibility != View.VISIBLE) View.VISIBLE else View.GONE
            if (state == Player.STATE_READY) flow?.duration = player.duration.takeIf { it != C.TIME_UNSET }?.let { it / 1000.0 } ?: 0.0
        }

        override fun onTracksChanged(tracks: Tracks) { applySubtitles() }

        override fun onAudioSessionIdChanged(audioSessionId: Int) { applyFx() }

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
        controls.tick() // the sleep timer runs while casting too (it pauses the TV)
        val c = cast
        if (c != null && c.casting) {
            // the receiver plays: its position and the controller's reports / renewal; nothing local runs
            c.sleepAfterEpisode = controls.sleep.afterEpisode // the TV stops after its episode
            if (now - castPolled >= CAST_POLL_MS) { castPolled = now; castLink?.publish(); c.tick() }
            return
        }
        reporter?.tick(background = inBackground)
        if (!(inBackground && !player.playWhenReady)) offlineProgress?.tick()
        if (retries > 0 && player.isPlaying && player.currentPosition > errorAt + STABLE_MS) {
            if (retries > 0) flash(getString(R.string.player_reconnected), 1_500)
            retries = 0
        }
        val f = flow ?: run { skipButton.visibility = View.GONE; nextCard.visibility = View.GONE; stillCard.visibility = View.GONE; return }
        f.holdAutoplay = controls.sleep.afterEpisode
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
            nextLabel.text = when {
                c.counting -> getString(R.string.player_next_counting, c.secondsLeft)
                controls.sleep.afterEpisode -> getString(R.string.player_next_pause_after)
                else -> getString(R.string.player_next)
            }
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
        playItem(next.id)
    }

    /**
     * Another title in this player (the next episode, a pick in the Episodes panel): the per-title state is reset (speed 1, a sleep
     * timer "after this episode" consumed, the title's flow, languages and extras loaded again). While casting it plays on the TV.
     */
    private fun playItem(id: String) = titleSwitch.play(id)

    private val titleSwitch = TitleSwitch(object : TitleSwitch.Steps {
        override fun newTitle() = controls.newTitle()
        override fun casting() = cast?.casting == true
        override fun playOnTv(id: String) = this@PlayerActivity.playOnTv(id)
        override fun cancelLoad() { loadJob?.cancel(); loadJob = null; hideError() }
        override fun resetLocal() = resetForNewTitle()
        override fun startOnline(id: String) {
            args = args.copy(itemId = id, startMs = null)
            loading.visibility = View.VISIBLE
            startOnline(args, first = true, startMs = null)
        }
    })

    private fun resetForNewTitle() {
        reporter?.release()
        reporter = null
        stream = null
        attachedAt = null
        flow = null
        nextItem = null
        langs = null
        audioIndex = null
        forcedHls = false
        retries = 0
        player.stop()
        nextCard.visibility = View.GONE
        stillCard.visibility = View.GONE
    }

    /** a title picked while casting starts on the TV (the cast session switches its token); the local player stays stopped */
    private fun playOnTv(id: String) {
        val pa = api
        val cur = item
        lifecycleScope.launch {
            val ep = controls.episodesCache.find(id)
            val info = pa?.let { withContext(Dispatchers.IO) { runCatching { it.item(id) }.getOrNull() } }
                ?: ItemInfo(id, "Episode", ep?.name.orEmpty(), cur?.seriesName, cur?.seriesId, ep?.season, ep?.episode)
            // the cast ended meanwhile: its hand-back (onReturn) already plays here; the pick is dropped, never a second load
            cast?.takeIf { it.casting }?.playOnTv(info)
        }
    }

    // ---- audio / subtitles / quality (the Tracks and More panels, PlayerControls) ----

    private val controlsHost = object : PlayerControls.Host {
        override fun active(): Player = view.player ?: player
        override fun casting() = cast?.casting == true
        override fun offline() = offlineLicense != null || args.licenseId != null
        override fun inPip() = isInPip()
        override fun flash(text: String, ms: Long) = this@PlayerActivity.flash(text, ms)
        override fun pipSupported() = this@PlayerActivity.pipSupported()
        override fun enterPip() = this@PlayerActivity.enterPip()
        override fun pauseActive() { active().pause() }

        override fun tracks(): TracksState? {
            val s = stream
            if (s == null && offlineLicense == null) return null
            return TracksState(
                audio = s?.info?.audioTracks.orEmpty(),
                audioIndex = audioIndex,
                subs = s?.info?.subtitles?.map { it.index to it.title } ?: offlineSubLangs.mapIndexed { i, lang -> i to lang },
                subIndex = subIndex,
                canSearch = serverCaps.subtitleSearch && offlineLicense == null && args.licenseId == null && !casting() && api != null,
                fxMode = fxMode,
                fxDisabledReason = fxDisabledReason(fx.supported(), casting()),
            )
        }

        override val tracksActions = object : TracksActions {
            override fun audio(t: AudioTrack) { changeAudio(t) }
            override fun subtitle(index: Int?) { setSubtitle(index, stream?.info?.subtitles?.firstOrNull { it.index == index }?.language) }
            override fun search() { openSubtitleSearch() }
            override fun fx(mode: String) { changeFx(mode) }
        }

        override fun qualities(): List<Pair<String, Long>>? {
            val s = stream ?: return null
            return QUALITIES.filter { (_, bps) -> s.info.roleMaxBitrate == null || bps < s.info.roleMaxBitrate }
        }

        override fun quality() = quality
        override fun changeQuality(bps: Long) = this@PlayerActivity.changeQuality(bps)

        override fun episodes(): EpisodesSource? {
            val pa = api ?: return null
            val cur = item ?: return null
            if (!EpisodesPanel.offered(cur.type, cur.seriesId, offline())) return null
            return EpisodesSource(pa, imageLoader(pa), cur.seriesId!!, cur.season, cast?.itemId ?: args.itemId)
        }

        override fun playItem(id: String) = this@PlayerActivity.playItem(id)

        override fun images(): ImageLoader? = api?.let(::imageLoader)

        override fun bookmarks(): BookmarksSource? {
            val pa = api ?: return null
            return if (offline()) null else BookmarksSource(pa, cast?.itemId ?: args.itemId)
        }

        override fun info(): InfoSource? {
            val pa = api ?: return null
            return if (offline()) null else InfoSource(pa, imageLoader(pa), cast?.itemId ?: args.itemId)
        }

        override fun openTitle(id: String) = this@PlayerActivity.openTitle(id)
    }

    /** the panels' image loader for [pa]'s server (one per server, so its cache is shared by the panels and the preview) */
    private fun imageLoader(pa: PlayerApi): ImageLoader =
        images?.takeIf { it.first === pa.server }?.second ?: ImageLoader(pa.server).also { images = pa.server to it }

    /** *Find subtitles …*: the search panel; a downloaded subtitle reloads playback at the current position (web pickSub). */
    private fun openSubtitleSearch() {
        val pa = api ?: return
        if (offlineLicense != null || args.licenseId != null || cast?.casting == true || isInPip()) return
        val lang = TitleLangs.appLang(resources.configuration.locales[0])
        val itemId = args.itemId
        controls.panel.show(
            getString(R.string.player_subs_title),
            SubtitleSearchPanel.build(this, lifecycleScope, pa, itemId, lang) {
                controls.panel.close()
                reload(resumePos())
                flash(getString(R.string.player_subs_added), 2_500)
            },
        )
    }

    /** A switch was flipped: applied at once, kept for this profile on the device and saved for the profile (web toggleFx). */
    private fun changeFx(mode: String) {
        val old = fxMode
        fxTouched = true
        setFx(mode)
        api?.let { pa ->
            lifecycleScope.launch(Dispatchers.IO) {
                try { pa.saveAudioFx(mode) } catch (_: SessionExpired) { } // offline / failed: still remembered on this device
            }
        }
        fxToggle(old, mode)?.let { (name, on) -> flash(getString(if (on) R.string.player_fx_on else R.string.player_fx_off, getString(name)), 1_400) }
    }

    private fun setFx(mode: String) {
        fxMode = mode
        FxStore.save(this, args.profileId, mode)
        applyFx()
    }

    /** the sound mode on the local player's audio session; nothing while casting (the TV plays) */
    private fun applyFx() {
        if (released) return
        if (cast?.casting == true) fx.release() else fx.apply(player.audioSessionId, fxMode)
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
        controls.onPip(isInPictureInPictureMode)
        view.useController = !isInPictureInPictureMode && !controls.locked
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
        if (!isInPictureInPictureMode) {
            inBackground = true
            if (!backgroundAudio) player.pause()
        }
    }

    override fun onStart() {
        super.onStart()
        inBackground = false
    }

    /**
     * A download paused for a long time (e.g. in the background) and resumed from anywhere (screen, notification, Bluetooth):
     * the offline rules are checked again before it goes on (the offline window or the licence may have ended meanwhile).
     */
    private fun checkOfflineAfterLongPause() {
        val lic = offlineLicense ?: run { pausedAt = null; return }
        val since = pausedAt
        pausedAt = null
        if (verifying || since == null || android.os.SystemClock.elapsedRealtime() - since < OFFLINE_RECHECK_MS) return
        verifying = true
        player.pause()
        pausedAt = null
        lifecycleScope.launch {
            val p = Offline.get(applicationContext).prepare(lic)
            verifying = false
            if (p is Prepared.Blocked) {
                player.stop()
                showError(getString(OfflineActivity.reasonText(p.reason)), retry = false)
            } else {
                player.play()
            }
        }
    }

    // ---- viewer activity (still watching) ----

    /** Any touch, key or remote button on the player screen. */
    override fun onUserInteraction() {
        super.onUserInteraction()
        Players.still.noteInteraction()
    }

    // ---- Chromecast ----

    private var castPolled = 0L

    /** The Cast framework (Google Play services) asynchronously; without it there is no Cast button. */
    private fun setUpCast() {
        try {
            CastContext.getSharedInstance(applicationContext, ContextCompat.getMainExecutor(this))
                .addOnSuccessListener { ctx -> if (!released) attachCast(ctx) }
                .addOnFailureListener { e -> Log.w(TAG, "cast unavailable ${e.javaClass.simpleName}") }
        } catch (e: RuntimeException) {
            Log.w(TAG, "cast unavailable ${e.javaClass.simpleName}")
        }
    }

    private fun attachCast(ctx: CastContext) {
        val media3 = androidx.media3.cast.Cast.getSingletonInstance(applicationContext)
        if (media3.needsInitialization()) media3.initialize()
        // the running Cast app: FriendFlix's own receiver unless it is the Default Media Receiver (fixed for this process)
        val custom = CastConfig.customId(ctx.castOptions.receiverApplicationId).isNotEmpty()
        val link = MediaThreeReceiver(applicationContext, ctx, custom, castEvents)
        castLink = link
        cast = CastController(
            server = CastServerProxy(), receiver = link, host = castHost, still = Players.still,
            io = Players.reports, main = ContextCompat.getMainExecutor(this), now = System::currentTimeMillis,
            // app-scoped: the session end after a title finished on the TV must outlive this screen (it closes at that moment)
            schedule = { ms, block -> val r = Runnable(block); Players.castHandler.postDelayed(r, ms); { Players.castHandler.removeCallbacks(r) } },
        )
        CastButtonFactory.setUpMediaRouteButton(applicationContext, castButton)
        updateCastButton()
    }

    /** The server calls for the playing profile (known once a stream started). */
    private inner class CastServerProxy : CastServer {
        private fun real() = castServer
        override fun session(body: JSONObject) = real()?.session(body) ?: TokenAnswer.Failed
        override fun revoke(castId: String) { real()?.revoke(castId) }
        override fun report(kind: PlaybackReporter.Kind, body: JSONObject) { real()?.report(kind, body) }
        override fun next(itemId: String) = real()?.next(itemId)
        override fun segments(itemId: String) = real()?.segments(itemId) ?: emptyList()
    }

    /** a stream (never a download), casting offered by the server, a device on the network; always while a cast runs */
    private fun updateCastButton() {
        if (!::controls.isInitialized) return
        val offline = offlineLicense != null || (::args.isInitialized && args.licenseId != null)
        controls.updateCast(CastUi(ready = castLink != null, enabled = castEnabled, devices = castDevices, casting = cast?.casting == true, offline = offline))
    }

    private val castEvents = object : MediaThreeReceiver.Events {
        override fun onDevices(available: Boolean) { castDevices = available; updateCastButton() }

        override fun onSessionStarted() {
            // the viewer picked a TV (Player.svelte handleCast session-start): the playing stream goes there
            val c = cast ?: return
            if (stream == null || c.casting || offlineLicense != null) return
            val f = flow
            val started = c.start(CastStart(
                itemId = args.itemId,
                positionMs = player.currentPosition.coerceAtLeast(0),
                audioIndex = audioIndex,
                subIndex = subIndex,
                maxBitrate = quality.takeIf { it > 0 },
                prefsBitrate = prefs.quality.takeIf { it >= MIN_BITRATE },
                isEpisode = item?.type == "Episode",
                prefs = prefs.flow,
                offline = false,
                segments = f?.segments ?: emptyList(),
                subtitleStyle = prefs.subtitleStyle.toJson(),
            ))
            if (started) { stream = null; showCasting() }
        }

        override fun onSessionEnded() { cast?.onSessionEnded() }
        override fun onState(st: ReceiverState) { cast?.onReceiver(st) }
        override fun onMediaEnd(reason: IdleReason, castId: String) { cast?.onMediaEnd(reason, castId) }
        override fun onSeeked(positionMs: Long) { cast?.onSeeked(positionMs) }
        override fun onLoadFailed() { cast?.onLoadFailed() }
        override fun onMessage(m: JSONObject) { cast?.onReceiverMessage(m) }
    }

    private val castHost = object : CastHost {
        override fun stopLocal() {
            // like Player.svelte startCast: the local session's stop, local playback off (the stream slot is free for the token)
            loadJob?.cancel()
            reporter?.release()
            reporter = null
            retries = 0
            player.playWhenReady = false
            player.stop()
        }

        override fun onCasting(itemId: String) { showCasting() }

        override fun onTitle(item: ItemInfo) {
            this@PlayerActivity.item = item
            nextItem = null
            flow = null
            audioIndex = null
            subIndex = null
            args = args.copy(itemId = item.id, startMs = null, audio = null, subtitle = null)
            title.text = item.seriesName ?: item.name
            subtitle.text = if (item.seriesName != null) episodeLabel(item) else ""
            // the TV's new title: its scenes and bookmarks (seeks and new bookmarks go to the TV)
            api?.let { controls.loadTitleExtras(it, item.id, serverCaps.chapters) } ?: controls.clearTitleExtras()
        }

        override fun onFailed(answer: TokenAnswer?) {
            val text = when (answer) {
                is TokenAnswer.MaxStreams -> resources.getQuantityString(R.plurals.player_error_max_streams, answer.max, answer.max)
                TokenAnswer.NeedsTranscode -> getString(R.string.cast_needs_transcode)
                TokenAnswer.DevicePending -> getString(R.string.cast_device_pending)
                null -> getString(R.string.cast_load_failed)
                else -> getString(R.string.cast_failed)
            }
            flash(text, 4_000)
        }

        override fun onReturn(itemId: String, positionMs: Long?, play: Boolean, ended: Boolean) {
            showLocal()
            if (ended) { finish(); return } // finished on the TV: back to the app, which offers what comes next
            // the TV's position (and title, after its queue moved on: no flow loaded for it yet) plays on here
            val same = itemId == args.itemId && flow != null
            args = args.copy(itemId = itemId, startMs = positionMs)
            // paused when the TV was, and when nobody could hear it (lost TV while the phone is locked, background audio off)
            startPaused = !play || (inBackground && !backgroundAudio)
            loading.visibility = View.VISIBLE
            val a = args
            // after the cast token's stop / revoke (queued on the same ordered thread): a one-stream account is not refused (429)
            Players.reports.execute {
                handler.post {
                    if (released || cast?.casting == true) return@post
                    if (same) startOnline(a, first = false, startMs = positionMs)
                    else { flow = null; nextItem = null; startOnline(a, first = true, startMs = positionMs) }
                }
            }
        }

        override fun receiverStrings(): JSONObject = JSONObject()
            .put("next", getString(R.string.player_next))
            .put("upNext", getString(R.string.cast_up_next, "{label}"))
            .put("watchCredits", getString(R.string.player_watch_credits))
            .put("startsIn", JSONArray((1..CastController.COUNTDOWN_SECONDS).map { resources.getQuantityString(R.plurals.cast_starts_in, it, it) }))
            .put("stillTitle", getString(R.string.player_still_title))
            .put("stillText", getString(R.string.player_still_text, "{ep}"))
            .put("keepWatching", getString(R.string.player_keep_watching))
            .put("skip", JSONObject().put("intro", getString(R.string.player_skip_intro)).put("recap", getString(R.string.player_skip_recap)))
    }

    /** the screen is the receiver's remote: its controls drive the TV, the local-only buttons go */
    private fun showCasting() {
        val link = castLink ?: return
        loading.visibility = View.GONE
        hideError()
        skipButton.visibility = View.GONE
        nextCard.visibility = View.GONE
        stillCard.visibility = View.GONE
        view.player = link.player
        view.controllerShowTimeoutMs = 0 // a remote: the controls stay
        controls.onCasting() // first: a lock is lifted, else the controller could not show
        view.showController()
        castStatus.text = link.deviceName?.let { getString(R.string.cast_playing_on, it) } ?: getString(R.string.cast_playing)
        castStatus.visibility = View.VISIBLE
        for (b in listOf(tracksButton, nextButton)) b.visibility = View.GONE
        controls.chip.hide()
        applyFx()
        updateCastButton()
        updatePip()
    }

    /** back from the TV: the local player is the screen's again */
    private fun showLocal() {
        view.player = player
        view.controllerShowTimeoutMs = CONTROLLER_TIMEOUT_MS
        castStatus.visibility = View.GONE
        updateCastButton()
        applyFx()
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
        if (cast?.casting == true) { cast?.stop(); showLocal() }
        controls.newTitle()
        controls.showEpisodesButton(false) // shown again once the new title is known
        reporter?.release()
        reporter = null
        offlineProgress?.flush()
        offlineProgress = null
        offlineLicense = null
        offlineSubLangs = emptyList()
        pausedAt = null
        stream = null
        attachedAt = null
        flow = null
        nextItem = null
        langs = null
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

    private val closeOnReset: () -> Unit = { finish() }

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
        if (released) return
        released = true
        PlayerReset.unlisten(closeOnReset)
        token?.let { Players.launcher?.ended(it) } // the same title may be played again right away
        if (!::player.isInitialized) return
        handler.removeCallbacksAndMessages(null)
        controls.release()
        fx.release()
        loadJob?.cancel()
        cast?.stop() // the player closes: the cast ends with it (the web's pagehide)
        cast = null
        castLink?.release()
        castLink = null
        reporter?.release()
        offlineProgress?.flush()
        player.removeListener(events)
        player.removeListener(listener)
        PlayerHolder.mayPlay = { true }
        view.player = null
        controller?.let { MediaController.releaseFuture(it) }
        controller = null
        PlayerHolder.release()
        PlaybackSession.stop(applicationContext)
    }

    /**
     * The server's active profile is not the one this request was made for (a stale `/watch` link, a profile switched in another
     * window): the web UI's own watch page plays it instead, with the session's real profile.
     */
    private fun openInWeb(a: Args, startMs: Long?) {
        val q = listOfNotNull(
            startMs?.takeIf { it >= 1000 }?.let { "t=${it / 1000}" },
            a.audio?.let { "audio=$it" },
            a.subtitle?.let { "sub=$it" },
        ).joinToString("&")
        val path = "/watch/${a.itemId}" + if (q.isEmpty()) "" else "?$q"
        startActivity(
            ShellIntents.internal(this)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(ShellActivity.EXTRA_WEB_WATCH, path),
        )
        finish()
    }

    /** A title tapped in Cast & info: the player closes and the shell's web UI opens its page (the web's `/item/<id>`). */
    private fun openTitle(id: String) {
        val path = ShellIntents.titlePath(id) ?: return
        startActivity(
            ShellIntents.internal(this)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(ShellActivity.EXTRA_OPEN_PATH, path),
        )
        finish()
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
        /** the receiver's position is mirrored about once a second while casting */
        private const val CAST_POLL_MS = 1_000L
        /** activity_player.xml show_timeout */
        private const val CONTROLLER_TIMEOUT_MS = 3_000
        private const val TICKS_PER_MS = 10_000L
        private const val MAX_RETRIES = 3
        private const val RETRY_BASE_MS = 1_000L
        /** playing this far past the error position: the error budget starts over (web freshRecovery) */
        private const val STABLE_MS = 8_000L
        private const val MIN_BITRATE = 300_000L
        /** the web OfflinePlayer resumes only past 5 s */
        private const val OFFLINE_MIN_RESUME_MS = 5_000L
        /** a download paused longer than this is checked against the offline rules again before it plays on */
        private const val OFFLINE_RECHECK_MS = 5 * 60_000L
        private const val PIP_MIN_RATIO = 0.42f
        private const val PIP_MAX_RATIO = 2.39f

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
    /** main-thread handler that outlives player screens (the cast session's delayed end) */
    val castHandler = Handler(Looper.getMainLooper())
    /** the app's launcher (set by the shell) */
    @Volatile var launcher: NativePlayerLauncher? = null
}
