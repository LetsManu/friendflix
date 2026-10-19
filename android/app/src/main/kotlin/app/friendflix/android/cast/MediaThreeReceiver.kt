// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.cast

import android.content.Context
import android.util.Log
import androidx.annotation.OptIn
import androidx.core.net.toUri
import androidx.media3.cast.MediaItemConverter
import androidx.media3.cast.RemoteCastPlayer
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import com.google.android.gms.cast.HlsSegmentFormat
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaMetadata
import com.google.android.gms.cast.MediaQueueItem
import com.google.android.gms.cast.MediaStatus
import com.google.android.gms.cast.MediaTrack
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastSession
import com.google.android.gms.cast.framework.CastState
import com.google.android.gms.cast.framework.CastStateListener
import com.google.android.gms.cast.framework.SessionManagerListener
import com.google.android.gms.cast.framework.media.RemoteMediaClient
import com.google.android.gms.common.images.WebImage
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException

/**
 * A cast token as the receiver gets it, like web lib/cast.ts `mediaOf` / `loadOnCast` / `queueOnCast`: the server's content URL as
 * the content id (HLS, TS segments, buffered), its duration, TV-show / movie metadata with the server's poster URL, the server's signed
 * WebVTT URLs as text tracks (ids 1…n), and, for FriendFlix's own receiver only, `customData.ff.castId` (the public handle its report
 * token is matched by). Nothing is built or changed here, and the report token never goes into the media.
 */
@OptIn(UnstableApi::class)
class TokenConverter(private val custom: Boolean) : MediaItemConverter {
    private class Entry(val info: CastInfo, val subIndex: Int?, val autoplay: Boolean)

    private val entries = LinkedHashMap<String, Entry>()

    /** The Media3 item for [info] (its media id is the cast id); [toMediaQueueItem] turns it into the receiver's item. */
    fun item(info: CastInfo, subIndex: Int?, autoplay: Boolean): MediaItem {
        entries.remove(info.castId)
        entries[info.castId] = Entry(info, subIndex, autoplay)
        while (entries.size > MAX_ENTRIES) entries.remove(entries.keys.first())
        return MediaItem.Builder().setMediaId(info.castId).setUri(info.contentUrl).setMimeType(MimeTypes.APPLICATION_M3U8).build()
    }

    /** the cast id of a receiver item (null: not one of ours) */
    fun castIdOf(q: MediaQueueItem?): String? {
        val media = q?.media ?: return null
        val tagged = media.customData?.optJSONObject("ff")?.optString("castId")?.takeIf { entries.containsKey(it) }
        return tagged ?: entries.entries.firstOrNull { it.value.info.contentUrl == media.contentId }?.key
    }

    override fun toMediaQueueItem(mediaItem: MediaItem): MediaQueueItem {
        val e = entries[mediaItem.mediaId] ?: throw IllegalArgumentException("not a cast token item")
        return queueItem(e.info, e.subIndex, e.autoplay, custom)
    }

    override fun toMediaItem(mediaQueueItem: MediaQueueItem): MediaItem =
        MediaItem.Builder().setMediaId(castIdOf(mediaQueueItem) ?: FOREIGN).build()

    companion object {
        const val FOREIGN = "foreign"
        private const val MAX_ENTRIES = 8
        /** lib/cast.ts QUEUE_PRELOAD_S */
        const val PRELOAD_S = 30.0

        fun queueItem(info: CastInfo, subIndex: Int?, autoplay: Boolean, custom: Boolean): MediaQueueItem {
            val meta = MediaMetadata(if (info.seriesName != null) MediaMetadata.MEDIA_TYPE_TV_SHOW else MediaMetadata.MEDIA_TYPE_MOVIE)
            meta.putString(MediaMetadata.KEY_TITLE, info.title)
            info.seriesName?.let { meta.putString(MediaMetadata.KEY_SERIES_TITLE, it) }
            info.imageUrl?.let { meta.addImage(WebImage(it.toUri())) }
            val tracks = info.subtitles.mapIndexed { i, s ->
                MediaTrack.Builder((i + 1).toLong(), MediaTrack.TYPE_TEXT)
                    .setContentId(s.url)
                    .setContentType("text/vtt")
                    .setSubtype(MediaTrack.SUBTYPE_SUBTITLES)
                    .setName(s.title)
                    .setLanguage(s.language?.take(2)?.takeIf { it.isNotEmpty() } ?: "und")
                    .build()
            }
            val media = MediaInfo.Builder(info.contentUrl)
                .setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
                .setContentType(info.contentType)
                .setHlsSegmentFormat(HlsSegmentFormat.TS)
                .setMetadata(meta)
                .setMediaTracks(tracks)
                .apply {
                    info.runtimeTicks?.let { setStreamDuration(it / 10_000) }
                    if (custom) setCustomData(JSONObject().put("ff", JSONObject().put("castId", info.castId)))
                }
                .build()
            val active = subIndex?.let { want -> info.subtitles.indexOfFirst { it.index == want }.takeIf { it >= 0 } }
            return MediaQueueItem.Builder(media)
                .setAutoplay(autoplay)
                .setStartTime(info.startTime.toDouble())
                .setPreloadTime(PRELOAD_S)
                .apply { if (active != null) setActiveTrackIds(longArrayOf(active + 1L)) }
                .build()
        }
    }
}

/**
 * The Cast receiver through Media3's [RemoteCastPlayer] (the player the controls drive while casting) and the Cast framework (session,
 * device availability, the own receiver's private channel). Main thread only. Logs carry no titles, URLs or tokens.
 */
@OptIn(UnstableApi::class)
class MediaThreeReceiver(
    context: Context,
    private val castContext: CastContext,
    override val custom: Boolean,
    private val events: Events,
) : CastReceiver {
    interface Events {
        fun onDevices(available: Boolean)
        /** the viewer picked a Cast device (a new session) */
        fun onSessionStarted()
        fun onSessionEnded()
        fun onState(st: ReceiverState)
        /** the media of token [castId] ended on the receiver */
        fun onMediaEnd(reason: IdleReason, castId: String)
        fun onSeeked(positionMs: Long)
        fun onLoadFailed()
        fun onMessage(m: JSONObject)
    }

    private val converter = TokenConverter(custom)
    val player: RemoteCastPlayer = RemoteCastPlayer.Builder(context)
        .setMediaItemConverter(converter)
        .setSeekBackIncrementMs(SEEK_MS)
        .setSeekForwardIncrementMs(SEEK_MS)
        .build()
    /** the token the receiver last had loaded (null: none since the last load / end) */
    private var lastLoaded: String? = null
    private var idleReason = IdleReason.UNKNOWN
    private var client: RemoteMediaClient? = null
    private var released = false

    private val statusCallback = object : RemoteMediaClient.Callback() {
        override fun onStatusUpdated() {
            val st = client?.mediaStatus ?: return
            if (st.playerState == MediaStatus.PLAYER_STATE_IDLE) idleReason = reasonOf(st.idleReason)
            else idleReason = IdleReason.UNKNOWN
        }
    }

    private val playerListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) { publish() }

        override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
            if (reason == Player.DISCONTINUITY_REASON_SEEK) events.onSeeked(newPosition.positionMs)
        }

        override fun onPlayerError(error: PlaybackException) {
            Log.w(TAG, "receiver error ${error.errorCodeName}")
            events.onLoadFailed()
        }
    }

    private val stateListener = CastStateListener { state -> events.onDevices(state != CastState.NO_DEVICES_AVAILABLE) }

    private val sessions = object : SessionManagerListener<CastSession> {
        override fun onSessionStarted(session: CastSession, sessionId: String) { attach(session); events.onSessionStarted() }
        override fun onSessionResumed(session: CastSession, wasSuspended: Boolean) { attach(session) }
        override fun onSessionEnded(session: CastSession, error: Int) { detach(session); events.onSessionEnded() }
        override fun onSessionStarting(session: CastSession) {}
        override fun onSessionStartFailed(session: CastSession, error: Int) {}
        override fun onSessionEnding(session: CastSession) {}
        override fun onSessionResuming(session: CastSession, sessionId: String) {}
        override fun onSessionResumeFailed(session: CastSession, error: Int) {}
        override fun onSessionSuspended(session: CastSession, reason: Int) {}
    }

    init {
        player.addListener(playerListener)
        castContext.addCastStateListener(stateListener)
        castContext.sessionManager.addSessionManagerListener(sessions, CastSession::class.java)
        castContext.sessionManager.currentCastSession?.let(::attach)
        events.onDevices(castContext.castState != CastState.NO_DEVICES_AVAILABLE)
    }

    /** a Cast session is connected */
    val connected: Boolean get() = castContext.sessionManager.currentCastSession?.isConnected == true

    /** the TV's name for the "playing on" line (shown, never logged) */
    val deviceName: String? get() = castContext.sessionManager.currentCastSession?.castDevice?.friendlyName

    override fun load(info: CastInfo, subIndex: Int?, autoplay: Boolean) {
        lastLoaded = null
        idleReason = IdleReason.UNKNOWN
        player.setMediaItems(listOf(converter.item(info, subIndex, autoplay)), 0, info.startTime * 1000)
        player.playWhenReady = autoplay
        player.prepare()
    }

    override fun queue(info: CastInfo, autoplay: Boolean): Boolean {
        if (player.mediaItemCount == 0) return false
        player.addMediaItem(converter.item(info, null, autoplay))
        return true
    }

    override fun dequeue(castId: String) {
        for (i in player.mediaItemCount - 1 downTo 0) {
            if (player.getMediaItemAt(i).mediaId == castId && i != player.currentMediaItemIndex) player.removeMediaItem(i)
        }
    }

    override fun send(msg: JSONObject) {
        if (!custom) return
        try {
            castContext.sessionManager.currentCastSession?.sendMessage(NS, msg.toString())
        } catch (_: RuntimeException) {
            // gone with its session
        }
    }

    override fun end() {
        try { castContext.sessionManager.endCurrentSession(true) } catch (_: RuntimeException) { }
    }

    fun release() {
        if (released) return
        released = true
        player.removeListener(playerListener)
        castContext.removeCastStateListener(stateListener)
        castContext.sessionManager.removeSessionManagerListener(sessions, CastSession::class.java)
        castContext.sessionManager.currentCastSession?.let(::detach)
        player.release()
    }

    private fun attach(session: CastSession) {
        client?.unregisterCallback(statusCallback)
        client = session.remoteMediaClient?.also { it.registerCallback(statusCallback) }
        if (!custom) return
        try {
            session.setMessageReceivedCallbacks(NS) { _, _, raw -> parse(raw)?.let(events::onMessage) }
        } catch (_: IOException) {
        } catch (_: IllegalStateException) {
        }
    }

    private fun detach(session: CastSession) {
        client?.unregisterCallback(statusCallback)
        client = null
        lastLoaded = null
        if (!custom) return
        try { session.removeMessageReceivedCallbacks(NS) } catch (_: IOException) { } catch (_: IllegalArgumentException) { }
    }

    /** Mirrors the receiver into the controller; called on every player event and about once a second while casting (positions). */
    fun publish() {
        if (released) return
        val item = player.currentMediaItem
        val state = player.playbackState
        val id = item?.mediaId?.takeIf { it != TokenConverter.FOREIGN }
        val loaded = id != null && (state == Player.STATE_READY || state == Player.STATE_BUFFERING)
        val idle = state == Player.STATE_IDLE || state == Player.STATE_ENDED
        val duration = player.duration.takeIf { it != C.TIME_UNSET } ?: 0L
        events.onState(ReceiverState(
            castId = id,
            loaded = loaded,
            playing = player.isPlaying,
            paused = !player.playWhenReady,
            positionMs = player.currentPosition.coerceAtLeast(0),
            durationMs = duration,
            idle = idle,
        ))
        // the media ended on the receiver: it was loaded, and now it is idle (lib/cast.ts sync)
        val was = lastLoaded
        if (was != null && idle && connected) events.onMediaEnd(idleReason, was)
        lastLoaded = if (loaded) id else if (idle) null else was
    }

    private fun parse(raw: String?): JSONObject? {
        if (raw == null || raw.length > MAX_MESSAGE) return null
        return try { JSONObject(raw).takeIf { it.opt("t") is String } } catch (_: JSONException) { null }
    }

    companion object {
        /** the private channel to FriendFlix's own receiver (lib/cast.ts CAST_NS, cast-receiver/logic.js NS) */
        const val NS = "urn:x-cast:com.friendflix.cast"
        private const val TAG = "FFCast"
        private const val SEEK_MS = 10_000L
        private const val MAX_MESSAGE = 32_768

        fun reasonOf(r: Int) = when (r) {
            MediaStatus.IDLE_REASON_FINISHED -> IdleReason.FINISHED
            MediaStatus.IDLE_REASON_CANCELED -> IdleReason.CANCELLED
            MediaStatus.IDLE_REASON_INTERRUPTED -> IdleReason.INTERRUPTED
            MediaStatus.IDLE_REASON_ERROR -> IdleReason.ERROR
            else -> IdleReason.UNKNOWN
        }
    }
}
