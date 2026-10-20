// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaController
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.TimeUnit

/**
 * The one player of the process and its media session (lock screen, notification, Bluetooth / headset buttons). [PlayerActivity]
 * creates it ([acquire]) and releases it when it closes ([release]); [PlaybackSession] serves the session to the system.
 */
@OptIn(UnstableApi::class)
object PlayerHolder {
    @Volatile var player: ExoPlayer? = null
        private set
    @Volatile var session: MediaSession? = null
        private set
    /** Whether a play command from the session (notification, lock screen, Bluetooth) is followed; set by [PlayerActivity]. */
    @Volatile var mayPlay: () -> Boolean = { true }

    /** The player (created on first use, on the main thread) with its session; [sessionActivity] reopens the player screen. */
    fun acquire(context: Context, sessionActivity: PendingIntent): ExoPlayer {
        player?.let { return it }
        val app = context.applicationContext
        val p = ExoPlayer.Builder(app)
            .setSeekBackIncrementMs(SEEK_MS)
            .setSeekForwardIncrementMs(SEEK_MS)
            // audio focus: pause for calls and other apps; pause when headphones are unplugged
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .build()
        val s = MediaSession.Builder(app, GatedPlayer(p) { mayPlay() })
            .setId(SESSION_ID)
            .setSessionActivity(sessionActivity)
            .setCallback(TrustedOnly)
            .build()
        player = p
        session = s
        return p
    }

    fun release() {
        session?.release()
        session = null
        player?.release()
        player = null
    }

    /** Connects a controller to [PlaybackSession] so the service runs (notification while playing). Release the future's controller. */
    fun connect(context: Context): ListenableFuture<MediaController> =
        MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackSession::class.java))).buildAsync()

    /** Only the app itself, the system (notification, lock screen, Bluetooth via the platform session) and trusted controllers. */
    private object TrustedOnly : MediaSession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult =
            if (controller.isTrusted || controller.packageName == PACKAGE) {
                MediaSession.ConnectionResult.AcceptedResultBuilder(session).build()
            } else {
                MediaSession.ConnectionResult.reject()
            }
    }

    /** ±10 s like the web player */
    const val SEEK_MS = 10_000L
    private const val SESSION_ID = "friendflix-player"
    private val PACKAGE = app.friendflix.android.BuildConfig.APPLICATION_ID
}

/**
 * Media session service (foreground type mediaPlayback while playing). It serves [PlayerHolder]'s session; Media3 posts the playback
 * notification and handles media buttons. Background audio is decided by [PlayerActivity] (setting off: the player pauses when the
 * screen goes away, so the notification goes too).
 */
class PlaybackSession : MediaSessionService() {
    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = PlayerHolder.session

    override fun onTaskRemoved(rootIntent: Intent?) {
        // swiped away from recents: nothing plays on without a screen to come back to
        PlayerHolder.player?.pause()
        stopSelf()
    }

    companion object {
        fun stop(context: Context) { context.stopService(Intent(context, PlaybackSession::class.java)) }
    }
}

/**
 * "This device leaves its account" (sign-out of this device, server change; [app.friendflix.android.settings.DeviceReset]): every
 * player screen closes as if the person closed it (stop report, offline position, cast stop), then the player, its session and the
 * media session service go. [epoch] counts the resets. [stopAll] waits until the stop reports have left, so they still carry the
 * session cookie that the reset clears afterwards.
 */
object PlayerReset {
    private val count = MutableStateFlow(0L)
    val epoch: StateFlow<Long> = count.asStateFlow()
    private val screens = CopyOnWriteArraySet<() -> Unit>()

    /** A player screen: [close] runs on the main thread at a reset. */
    fun listen(close: () -> Unit) { screens += close }
    fun unlisten(close: () -> Unit) { screens -= close }

    suspend fun stopAll(context: Context) {
        val app = context.applicationContext
        withContext(Dispatchers.Main) {
            count.value++
            screens.toList().forEach { it() }
            PlayerHolder.release() // no screen (or one that already let go): the session must not outlive the account
            PlaybackSession.stop(app)
        }
        withContext(Dispatchers.IO) {
            try {
                Players.reports.submit {}.get(REPORT_WAIT_S, TimeUnit.SECONDS)
            } catch (_: Exception) {
                // a stuck report must not stop the reset
            }
        }
    }

    private const val REPORT_WAIT_S = 5L
}
