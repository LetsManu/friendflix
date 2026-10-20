// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import android.content.Context
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.friendflix.android.crypto.EncryptedWriter
import app.friendflix.android.crypto.KeyProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.SecureRandom
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

/**
 * The player's offline path on a real device / emulator: a bundled 4 s test pattern (H.264 baseline 160x90 + AAC, made with ffmpeg
 * `testsrc` + `sine`, ~50 KB) is written through [EncryptedWriter] and played with the same media source the player uses for downloads
 * ([MediaSources.encrypted] + [MediaSources.localItem]); it plays, seeks, and the position advances after the seek. No network.
 */
@RunWith(AndroidJUnit4::class)
class EncryptedPlaybackTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context: Context = instrumentation.targetContext
    private val file = File(context.cacheDir, "player-test.ffv")
    private var player: ExoPlayer? = null

    private val keys = object : KeyProvider {
        private val k = SecretKeySpec(random(32), "AES")
        private val m = SecretKeySpec(random(32), "HmacSHA256")
        override fun key(): SecretKey = k
        override fun macKey(): SecretKey = m
    }

    private fun random(n: Int) = ByteArray(n).also { SecureRandom().nextBytes(it) }

    @After fun tearDown() {
        instrumentation.runOnMainSync { player?.release() }
        file.delete()
    }

    private fun <T> main(block: () -> T): T {
        var out: Result<T>? = null
        instrumentation.runOnMainSync { out = runCatching(block) }
        return out!!.getOrThrow()
    }

    /** Polls [cond] on the main thread until it holds; fails with the player's state after [timeoutMs]. */
    private fun waitFor(what: String, timeoutMs: Long = 30_000, cond: (ExoPlayer) -> Boolean) {
        val until = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < until) {
            val p = player!!
            val (ok, err) = main { cond(p) to p.playerError }
            if (err != null) throw AssertionError("$what: playback error ${err.errorCodeName}", err)
            if (ok) return
            Thread.sleep(50)
        }
        val state = main { "state=${player!!.playbackState} playing=${player!!.isPlaying} pos=${player!!.currentPosition} dur=${player!!.duration}" }
        throw AssertionError("timed out waiting for $what ($state)")
    }

    @Test fun playsAnEncryptedClipAndSeeks() {
        val clip = instrumentation.context.assets.open("test-pattern.mp4").use { it.readBytes() }
        assertTrue("bundled clip stays small", clip.size < 200 * 1024)
        EncryptedWriter(file, keys).use { w ->
            w.append(clip)
            w.finish()
        }
        assertTrue("stored encrypted, not as the plain file", file.length() > clip.size && !file.readBytes().copyOfRange(25, 33).contentEquals(clip.copyOfRange(0, 8)))

        main {
            val p = ExoPlayer.Builder(context).build()
            player = p
            p.volume = 0f
            p.setMediaSource(MediaSources.encrypted(keys).createMediaSource(MediaSources.localItem(file, emptyList(), MediaMetadata.EMPTY)))
            p.prepare()
            p.play()
        }
        waitFor("ready") { it.playbackState == Player.STATE_READY }
        assertEquals(4_000.0, main { player!!.duration }.toDouble(), 300.0)
        waitFor("playback to advance") { it.isPlaying && it.currentPosition >= 500 }

        main { player!!.seekTo(2_000) }
        waitFor("position after the seek") { it.currentPosition >= 2_000 && it.playbackState == Player.STATE_READY }
        val afterSeek = main { player!!.currentPosition }
        waitFor("advance after the seek") { it.currentPosition >= afterSeek + 300 || it.playbackState == Player.STATE_ENDED }
        assertNull(main<PlaybackException?> { player!!.playerError })
    }
}
