// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.downloads.SessionExpired
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

/** An audio track of the playback answer. */
data class AudioTrack(val index: Int, val title: String, val language: String?, val isDefault: Boolean)

/** A text subtitle of the playback answer: a same-origin WebVTT URL served by FriendFlix / the media server. */
data class SubtitleTrack(val index: Int, val title: String, val language: String?, val url: String, val isDefault: Boolean)

/** `POST /api/playback/info` as the player uses it (backend media/types.ts PlaybackDto). */
data class PlaybackInfo(
    val playSessionId: String,
    val mediaSourceId: String,
    val directUrl: String?,
    val hlsUrl: String,
    val resumeTicks: Long,
    val maxBitrate: Long,
    val roleMaxBitrate: Long?,
    val audioIndex: Int?,
    val transcodeReason: String?,
    val audioTracks: List<AudioTrack>,
    val subtitles: List<SubtitleTrack>,
)

/** The title being played (`GET /api/items/:id` → item, or `/next`). */
data class ItemInfo(
    val id: String,
    val type: String?,
    val name: String,
    val seriesName: String?,
    val seriesId: String?,
    val season: Int?,
    val episode: Int?,
)

/** The profile preferences the player needs (`GET /api/prefs`), defaults = the web's DEFAULT_PREFS. */
data class PlayerPrefs(
    val flow: FlowPrefs = FlowPrefs(),
    val audioLang: String = "",
    val subtitleLang: String = "",
    /** saved quality cap in bit/s, 0 = automatic */
    val quality: Long = 0,
)

sealed interface InfoAnswer {
    data class Ok(val info: PlaybackInfo) : InfoAnswer
    /** 429 max_streams: the account's stream limit is reached (server rule, never bypassed) */
    data class MaxStreams(val max: Int) : InfoAnswer
    /** another 4xx (not allowed for this profile, not found …): the web player shows its generic error */
    data object Refused : InfoAnswer
    /** 5xx / network / malformed answer: worth a retry */
    data object Retry : InfoAnswer
}

/**
 * The server calls of the native player, through [ServerApi] (origin-only session cookie, `x-ff-profile`, CSRF). Blocking: call
 * off the main thread. URLs and bodies are never logged.
 */
class PlayerApi(val server: ServerApi, private val profileId: String) {

    fun info(body: JSONObject): InfoAnswer = try {
        val (code, j) = server.sendJson("/api/playback/info", profileId, body) ?: return InfoAnswer.Retry
        when {
            code == 200 && j != null -> parseInfo(j)?.let { InfoAnswer.Ok(it) } ?: InfoAnswer.Retry
            code == 429 && j?.optString("error") == "max_streams" -> InfoAnswer.MaxStreams(j.optInt("max", 1))
            code in 400..499 -> InfoAnswer.Refused
            else -> InfoAnswer.Retry
        }
    } catch (e: SessionExpired) {
        throw e
    } catch (_: IOException) {
        InfoAnswer.Retry
    }

    /** `POST /api/playback/<kind>`; best effort like the web (`.catch(() => undefined)`). */
    fun report(kind: PlaybackReporter.Kind, body: JSONObject) {
        try { server.sendJson("/api/playback/${kind.path}", profileId, body) } catch (_: IOException) { }
    }

    fun item(id: String): ItemInfo? = get("/api/items/$id")?.optJSONObject("item")?.let(::parseItem)

    fun next(id: String): ItemInfo? = get("/api/items/$id/next")?.optJSONObject("item")?.let(::parseItem)

    fun segments(id: String): List<Segment> {
        val a = get("/api/items/$id/segments")?.optJSONArray("segments") ?: return emptyList()
        return (0 until a.length()).mapNotNull { i ->
            val o = a.optJSONObject(i) ?: return@mapNotNull null
            val s = o.optDouble("start", Double.NaN)
            val e = o.optDouble("end", Double.NaN)
            if (s.isNaN() || e.isNaN() || e <= s) null else Segment(o.optString("type").lowercase(), s, e)
        }
    }

    /** Segment types this server offers skip buttons for (`/api/me` server.capabilities.segments; all four when not sent). */
    fun segmentTypes(): Set<String> {
        val caps = get("/api/me")?.optJSONObject("server")?.optJSONObject("capabilities") ?: return ALL_SEGMENTS
        val a = caps.optJSONArray("segments") ?: return ALL_SEGMENTS
        return (0 until a.length()).mapNotNull { a.optString(it).takeIf { s -> s.isNotEmpty() }?.lowercase() }.toSet()
    }

    fun prefs(): PlayerPrefs {
        val p = get("/api/prefs")?.optJSONObject("prefs") ?: return PlayerPrefs()
        val d = FlowPrefs()
        return PlayerPrefs(
            flow = FlowPrefs(
                autoplayNext = p.optBoolean("autoplayNext", d.autoplayNext),
                autoSkipIntro = p.optBoolean("autoSkipIntro", d.autoSkipIntro),
                stillWatching = p.optBoolean("stillWatching", d.stillWatching),
                stillWatchingEpisodes = p.optInt("stillWatchingEpisodes", d.stillWatchingEpisodes),
            ),
            audioLang = p.optString("audioLang"),
            subtitleLang = p.optString("subtitleLang"),
            quality = p.optLong("quality"),
        )
    }

    /** This series' saved audio / subtitle choice (`GET /api/series/:id/langpref`; an episode id resolves to its series). */
    fun langPref(seriesOrItem: String): Pair<String?, String?> {
        val j = get("/api/series/$seriesOrItem/langpref") ?: return null to null
        fun s(k: String) = if (j.isNull(k)) null else j.optString(k).takeIf { it.isNotEmpty() }
        return s("audio") to s("subtitle")
    }

    /** Remembers the viewer's audio / subtitle pick for the series (`PUT /api/series/:id/langpref`), best effort. */
    fun saveLangPref(seriesId: String, audio: String? = null, subtitle: String? = null): Boolean = try {
        val b = JSONObject().also { o -> audio?.let { o.put("audio", it) }; subtitle?.let { o.put("subtitle", it) } }
        server.sendJson("/api/series/$seriesId/langpref", profileId, b, method = "PUT")?.first == 200
    } catch (_: IOException) {
        false
    }

    private fun get(path: String): JSONObject? = try {
        val (code, j) = server.getJson(path, profileId)
        if (code == 200) j else null
    } catch (e: SessionExpired) {
        throw e
    } catch (_: IOException) {
        null
    }

    companion object {
        val ALL_SEGMENTS = setOf("intro", "outro", "recap", "preview")

        fun parseInfo(j: JSONObject): PlaybackInfo? {
            val ps = j.optString("playSessionId").takeIf { it.isNotEmpty() } ?: return null
            if (!j.has("resumeTicks")) return null
            val audio = j.optJSONArray("audioTracks") ?: return null
            val subs = j.optJSONArray("subtitles") ?: return null
            val direct = j.optString("directUrl").takeIf { it.isNotEmpty() }
            val hls = j.optString("hlsUrl").takeIf { it.isNotEmpty() }
            if (direct == null && hls == null) return null
            return PlaybackInfo(
                playSessionId = ps,
                mediaSourceId = j.optString("mediaSourceId"),
                directUrl = direct,
                hlsUrl = hls ?: "",
                resumeTicks = j.optLong("resumeTicks"),
                maxBitrate = j.optLong("maxBitrate"),
                roleMaxBitrate = if (j.has("roleMaxBitrate") && !j.isNull("roleMaxBitrate")) j.optLong("roleMaxBitrate") else null,
                audioIndex = if (j.has("audioIndex") && !j.isNull("audioIndex")) j.optInt("audioIndex") else null,
                transcodeReason = j.optString("transcodeReason").takeIf { it.isNotEmpty() },
                audioTracks = objects(audio).map { AudioTrack(it.optInt("index"), it.optString("title"), lang(it), it.optBoolean("isDefault")) },
                subtitles = objects(subs).mapNotNull { o ->
                    val url = o.optString("url").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                    SubtitleTrack(o.optInt("index"), o.optString("title"), lang(o), url, o.optBoolean("isDefault"))
                },
            )
        }

        private fun lang(o: JSONObject) = if (o.isNull("language")) null else o.optString("language").takeIf { it.isNotEmpty() }

        private fun objects(a: JSONArray): List<JSONObject> = (0 until a.length()).mapNotNull { a.optJSONObject(it) }

        private fun parseItem(o: JSONObject): ItemInfo? {
            val id = o.optString("id").takeIf { it.isNotEmpty() } ?: return null
            fun str(k: String) = if (o.isNull(k)) null else o.optString(k).takeIf { it.isNotEmpty() }
            fun int(k: String) = if (o.has(k) && !o.isNull(k)) o.optInt(k) else null
            return ItemInfo(id, str("type"), o.optString("name"), str("seriesName"), str("seriesId"), int("parentIndexNumber"), int("indexNumber"))
        }

        /**
         * The body of the first / every `POST /api/playback/info`, like web lib/player/infobody.ts `playbackInfoBody` plus the
         * device's [caps]: `{itemId, startTicks?, audioIndex?, maxBitrate?, reasonHint, audioLang?, caps}`.
         */
        fun infoBody(itemId: String, startMs: Long?, audioIndex: Int?, maxBitrate: Long?, manual: Boolean, audioLang: String?, caps: ClientCaps): JSONObject =
            JSONObject().apply {
                put("itemId", itemId)
                put("reasonHint", if (manual) "manual" else "network")
                startMs?.let { put("startTicks", it.coerceAtLeast(0) * 10_000) }
                audioIndex?.let { put("audioIndex", it) }
                maxBitrate?.takeIf { it in 300_000..200_000_000 }?.let { put("maxBitrate", it) }
                audioLang?.takeIf { it.isNotEmpty() && it.length <= 16 }?.let { put("audioLang", it) }
                put("caps", caps.toJson())
            }
    }
}
