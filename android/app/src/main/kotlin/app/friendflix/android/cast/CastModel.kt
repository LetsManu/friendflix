// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.cast

import com.google.android.gms.cast.CastMediaControlIntent
import org.json.JSONObject

/** A cast token's subtitle: the server's signed WebVTT URL for the receiver (passed on unchanged). */
data class CastSubtitle(val index: Int, val language: String?, val title: String, val url: String)

/**
 * The answer of `POST /api/cast/session` (web lib/cast.ts `CastInfo`). Every URL in it is the server's: the app hands them to the
 * receiver unchanged and never builds one itself. [report] is the own receiver's report token; it goes to the TV only on the private
 * channel, never into media metadata. [toString] shows no URL or token (logs never carry them).
 */
class CastInfo(
    val castId: String,
    val expiresAt: Long,
    val playSessionId: String,
    val mediaSourceId: String,
    val runtimeTicks: Long?,
    /** seconds */
    val startTime: Long,
    val contentUrl: String,
    val contentType: String,
    val hlsSegmentFormat: String,
    val title: String,
    val seriesName: String?,
    val imageUrl: String?,
    val subtitles: List<CastSubtitle>,
    val report: String?,
) {
    override fun toString() = "CastInfo(${castId.take(4)}…)"

    companion object {
        fun parse(j: JSONObject): CastInfo? {
            fun str(k: String) = if (j.isNull(k)) null else j.optString(k).takeIf { it.isNotEmpty() }
            val castId = str("castId") ?: return null
            val url = str("contentUrl") ?: return null
            val ps = str("playSessionId") ?: return null
            val subs = j.optJSONArray("subtitles")
            return CastInfo(
                castId = castId,
                expiresAt = j.optLong("expiresAt"),
                playSessionId = ps,
                mediaSourceId = j.optString("mediaSourceId"),
                runtimeTicks = if (j.has("runtimeTicks") && !j.isNull("runtimeTicks")) j.optLong("runtimeTicks") else null,
                startTime = j.optLong("startTime"),
                contentUrl = url,
                contentType = str("contentType") ?: "application/x-mpegURL",
                hlsSegmentFormat = str("hlsSegmentFormat") ?: "ts",
                title = j.optString("title"),
                seriesName = str("seriesName"),
                imageUrl = str("imageUrl"),
                subtitles = if (subs == null) emptyList() else (0 until subs.length()).mapNotNull { i ->
                    val o = subs.optJSONObject(i) ?: return@mapNotNull null
                    val u = o.optString("url").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                    CastSubtitle(o.optInt("index"), if (o.isNull("language")) null else o.optString("language").takeIf { it.isNotEmpty() }, o.optString("title"), u)
                },
                report = str("report"),
            )
        }
    }
}

/**
 * The answer of `POST /api/livetv/channels/:id/watch { via: 'chromecast' }` as the receiver needs it (spec §13): the stream's URL made
 * absolute against the shell's server origin, the channel's name, number and signed logo URL (absolute, or null), the programme
 * running now. [token] only leaves the device again in `DELETE /api/livetv/watch`; [handle] is the receiver item's id (a hash of the
 * token, never the token itself). [toString] shows neither the token nor the URL (logs never carry them).
 */
class LiveCastInfo(
    val channelId: String,
    val token: String,
    val contentUrl: String,
    val expiresAt: Long,
    val name: String,
    val number: Int?,
    val logo: String?,
    /** the title of the programme running now (null: no EPG data) */
    val now: String?,
    /** the playlist's segment format, [SEGMENTS_TS] or [SEGMENTS_FMP4] (an fMP4 / CMAF passthrough; bughunt M2) */
    val segments: String = SEGMENTS_TS,
) {
    /** the receiver item's media id: `live-` + 24 hex of `sha256(token)` (never a valid castId, so no film lookup is made for it) */
    val handle: String = "live-" + java.security.MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }.take(24)

    override fun toString() = "LiveCastInfo($channelId)"

    companion object {
        /** the HLS content type of a live channel (web Task 41 `loadLive`) */
        const val CONTENT_TYPE = "application/x-mpegURL"
        /** the watch answer's `segments`: MPEG-TS (also when an older backend does not say) or fMP4 */
        const val SEGMENTS_TS = "ts"
        const val SEGMENTS_FMP4 = "fmp4"
        private val TOKEN = Regex("^[A-Za-z0-9_-]{16,128}$")
        private val CHANNEL = Regex("^[A-Za-z0-9_-]{1,64}$")
        private const val PATH = "/media/l/"

        /**
         * [absolute] turns the answer's relative `url` (`/media/l/<token>/index.m3u8`) into a URL of the shell's server origin
         * ([app.friendflix.android.downloads.ServerApi.resolve]); null when the answer is not a live stream of that server.
         */
        fun parse(j: JSONObject, absolute: (String) -> String?): LiveCastInfo? {
            fun str(o: JSONObject, k: String) = if (o.isNull(k)) null else (o.opt(k) as? String)?.takeIf { it.isNotEmpty() }
            val token = str(j, "token")?.takeIf(TOKEN::matches) ?: return null
            val path = str(j, "url")?.takeIf { it.startsWith(PATH) } ?: return null
            val url = absolute(path) ?: return null
            val ch = j.optJSONObject("channel") ?: return null
            val id = str(ch, "id")?.takeIf(CHANNEL::matches) ?: return null
            val name = str(ch, "name") ?: return null
            val number = (ch.opt("number") as? Number)?.toInt()
            // the signed logo URL of the answer, used as it is (the receiver sends no cookie); anything but http(s) is dropped
            val logo = str(ch, "logo")?.takeIf { it.startsWith("https://") || it.startsWith("http://") }
            val now = j.optJSONObject("now")?.let { str(it, "title") }
            val segments = if (str(j, "segments") == SEGMENTS_FMP4) SEGMENTS_FMP4 else SEGMENTS_TS
            return LiveCastInfo(id, token, url, j.optLong("expiresAt"), name, number, logo, now, segments)
        }
    }
}

/** What a cast token request came back with (the server's rules: stream limit, transcoding role cap, kids rules). */
sealed interface TokenAnswer {
    class Ok(val info: CastInfo) : TokenAnswer
    /** 429 max_streams */
    data class MaxStreams(val max: Int) : TokenAnswer
    /** 403 transcoding_disabled: Chromecast always needs the transcoded stream */
    data object NeedsTranscode : TokenAnswer
    /** 403 device_pending: this device is not approved yet */
    data object DevicePending : TokenAnswer
    /** 409 cast_unpinned: the TV has not fetched the playing token yet, so no queued successor can be pinned to it (asked once more later) */
    data object Unpinned : TokenAnswer
    /** anything else (refused, network, 409 profile_changed, 400 bad_request, the next-token gate said no) */
    data object Failed : TokenAnswer
}

/** `GET /api/cast/config` and the receiver app id, like web lib/cast.ts `castConfigEnabled`. */
object CastConfig {
    private val APP_ID = Regex("^[0-9A-F]{8}$")

    data class Config(val enabled: Boolean, val receiverAppId: String)

    /** FriendFlix's own receiver id, or "" (the Default Media Receiver) when unset or not the web's `/^[0-9A-F]{8}$/`. */
    fun customId(raw: String?): String = raw?.takeIf { APP_ID.matches(it) } ?: ""

    /** The app id the Cast framework starts: the own receiver, else the Default Media Receiver. */
    fun receiverAppId(cached: String?): String = customId(cached).ifEmpty { CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID }

    fun parse(j: JSONObject?): Config? {
        if (j == null) return null
        return Config(enabled = j.optBoolean("enabled", false), receiverAppId = customId(if (j.isNull("receiverAppId")) null else j.optString("receiverAppId")))
    }
}

/**
 * `POST /api/cast/session` bodies with the web's keys and key order (unset values left out, as `JSON.stringify` drops undefined):
 * - [token]: Player.svelte `castRequest` / engine.ts `swap`: `{itemId, startTicks?, audioIndex?, maxBitrate?}`
 * - [queue]: engine.ts `prequeue`: `{itemId, maxBitrate?, next: true, after}` (the receiver queue's next episode follows the playing token)
 * - both plus `receiver: true` for FriendFlix's own receiver (lib/cast.ts `castBody`)
 */
object CastBodies {
    private const val TICKS_PER_MS = 10_000L

    fun token(itemId: String, startMs: Long?, audioIndex: Int?, maxBitrate: Long?, receiver: Boolean): JSONObject = JSONObject().apply {
        put("itemId", itemId)
        startMs?.let { put("startTicks", it.coerceAtLeast(0) * TICKS_PER_MS) }
        audioIndex?.let { put("audioIndex", it) }
        bitrate(maxBitrate)?.let { put("maxBitrate", it) }
        if (receiver) put("receiver", true)
    }

    fun queue(itemId: String, maxBitrate: Long?, after: String, receiver: Boolean): JSONObject = JSONObject().apply {
        put("itemId", itemId)
        bitrate(maxBitrate)?.let { put("maxBitrate", it) }
        put("next", true)
        put("after", after)
        if (receiver) put("receiver", true)
    }

    private fun bitrate(b: Long?) = b?.takeIf { it in 300_000..200_000_000 }
}

/**
 * The answer of `GET /api/cast/session/:castId`: what the server knows of one of this device's cast tokens. It carries no token, URL or
 * address; the receiver's own content URL ([toCastInfo]) is all a re-adopted cast needs.
 */
data class CastLookup(
    val castId: String,
    val itemId: String,
    val mediaSourceId: String,
    val playSessionId: String,
    val expiresAt: Long,
    val runtimeTicks: Long?,
    /** `chromecast` or `airplay` */
    val via: String,
    /** the token is a queued successor (`next: true`) */
    val next: Boolean,
    /** the playing token's `start` was reported */
    val reported: Boolean,
    val title: String,
    val seriesName: String?,
    val subtitles: List<CastSubtitle>,
) {
    /** the [CastInfo] of a cast found on the receiver: its own [contentUrl], subtitle URLs are already there (empty), no report token */
    fun toCastInfo(contentUrl: String) = CastInfo(
        castId = castId, expiresAt = expiresAt, playSessionId = playSessionId, mediaSourceId = mediaSourceId, runtimeTicks = runtimeTicks,
        startTime = 0, contentUrl = contentUrl, contentType = "application/x-mpegURL", hlsSegmentFormat = "ts", title = title,
        seriesName = seriesName, imageUrl = null, subtitles = subtitles, report = null,
    )

    companion object {
        fun parse(j: JSONObject): CastLookup? {
            fun str(k: String) = if (j.isNull(k)) null else j.optString(k).takeIf { it.isNotEmpty() }
            val castId = str("castId")?.takeIf(CastIds::valid) ?: return null
            val itemId = str("itemId") ?: return null
            val subs = j.optJSONArray("subtitles")
            return CastLookup(
                castId = castId,
                itemId = itemId,
                mediaSourceId = j.optString("mediaSourceId"),
                playSessionId = str("playSessionId") ?: return null,
                expiresAt = j.optLong("expiresAt"),
                runtimeTicks = if (j.has("runtimeTicks") && !j.isNull("runtimeTicks")) j.optLong("runtimeTicks") else null,
                via = j.optString("via", "chromecast"),
                next = j.optBoolean("next", false),
                reported = j.optBoolean("reported", false),
                title = j.optString("title"),
                seriesName = str("seriesName"),
                subtitles = if (subs == null) emptyList() else (0 until subs.length()).mapNotNull { i ->
                    val o = subs.optJSONObject(i) ?: return@mapNotNull null
                    CastSubtitle(o.optInt("index"), if (o.isNull("language")) null else o.optString("language").takeIf { it.isNotEmpty() }, o.optString("title"), "")
                },
            )
        }
    }
}

/** The public handle of a cast token: the first 32 hex characters of `sha256(token)` (the server's `castIdOf(hashToken(token))`). */
object CastIds {
    private val ID = Regex("^[0-9a-f]{32}$")
    /** the 43-character base64url token right after `/media/c/` of a cast content URL */
    private val TOKEN = Regex("/media/c/([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])")

    fun valid(id: String) = ID.matches(id)

    /** the castId of the token in a cast content URL, null when the URL carries none (other media, the test clip) */
    fun ofContentUrl(url: String?): String? {
        val token = TOKEN.find(url ?: return null)?.groupValues?.get(1) ?: return null
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }.take(32)
    }
}

/** What a receiver item is: its public handle (null: unknown) and its content URL (never logged). */
class ReceiverMedia(val castId: String?, val contentUrl: String) {
    override fun toString() = "ReceiverMedia(${castId?.take(4)}…)"
}

enum class CastKind { CHROMECAST }

/** The cast bar's phases: waiting for the TV's first playing update, playing (or paused), the title just ended on the TV. */
enum class CastPhase { CONNECTING, PLAYING, ENDED }

/** The queued next episode (the bar's up-next line). */
data class NextSnapshot(val itemId: String, val label: String)

/**
 * What a cast looks like from outside (the native bridge, Task 30): web `CastSession` in the shape the Android shell needs.
 * [title] is the series name for an episode and [subtitle] the episode's own title (the web bar's two lines); [posterId] is the item
 * whose poster the bar shows (a live cast: [live], the channel). No token, URL or castId in it.
 */
data class CastSnapshot(
    val kind: CastKind,
    val device: String,
    val itemId: String,
    val title: String,
    val subtitle: String?,
    val posterId: String,
    val isEpisode: Boolean,
    val positionMs: Long,
    val durationMs: Long,
    val paused: Boolean,
    val state: CastPhase,
    val next: NextSnapshot?,
    /** a live channel ([itemId] / [posterId] = the channel id, [title] its name, [subtitle] the programme now): no duration, no next */
    val live: Boolean = false,
)
