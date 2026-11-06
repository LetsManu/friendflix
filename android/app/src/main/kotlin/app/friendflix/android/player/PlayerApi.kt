// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.player

import app.friendflix.android.downloads.ServerApi
import app.friendflix.android.downloads.SessionExpired
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder

/** An audio track of the playback answer. */
data class AudioTrack(val index: Int, val title: String, val language: String?, val isDefault: Boolean)

/** A text subtitle of the playback answer: a same-origin WebVTT URL served by FriendFlix / the media server. */
data class SubtitleTrack(val index: Int, val title: String, val language: String?, val url: String, val isDefault: Boolean)

/** Timeline preview sheets of the playback answer: `url` has `{n}` = sheet index, thumbnails are [intervalMs] apart. */
data class TrickplayInfo(val width: Int, val height: Int, val tileWidth: Int, val tileHeight: Int, val count: Int, val intervalMs: Long, val url: String)

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
    val trickplay: TrickplayInfo? = null,
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

/** The profile's subtitle look (web stores.ts `SubtitleStyle`; defaults = DEFAULT_PREFS.subtitleStyle, merged like the web). */
data class SubtitleStyle(val size: String = "m", val color: String = "white", val background: String = "semi", val font: String = "sans") {
    fun toJson(): JSONObject = JSONObject().put("size", size).put("color", color).put("background", background).put("font", font)

    companion object {
        fun parse(o: JSONObject?): SubtitleStyle {
            val d = SubtitleStyle()
            if (o == null) return d
            fun str(k: String, def: String) = if (o.isNull(k)) def else o.optString(k).takeIf { it.isNotEmpty() && it.length <= 20 } ?: def
            return SubtitleStyle(str("size", d.size), str("color", d.color), str("background", d.background), str("font", d.font))
        }
    }
}

/** The profile preferences the player needs (`GET /api/prefs`), defaults = the web's DEFAULT_PREFS. */
data class PlayerPrefs(
    val flow: FlowPrefs = FlowPrefs(),
    val audioLang: String = "",
    val subtitleLang: String = "",
    /** saved quality cap in bit/s, 0 = automatic */
    val quality: Long = 0,
    val subtitleStyle: SubtitleStyle = SubtitleStyle(),
    /** sound processing: off | voices | night | both */
    val audioFx: String = "off",
    /** anime: original audio with subtitles by default */
    val animeOriginal: Boolean = false,
    /** post-play suggestions switched on for the profile */
    val postplay: Boolean = true,
    /** unwatched episodes show no picture (web spoiler.ts) */
    val spoilerProtection: Boolean = false,
)

/** What this server / account offers the player (`/api/me`); a flag that is not sent counts as true, like the web. */
data class ServerCaps(
    val chapters: Boolean = true,
    val trickplay: Boolean = true,
    val subtitleSearch: Boolean = true,
    val postplay: Boolean = true,
    val segments: Set<String> = PlayerApi.ALL_SEGMENTS,
    val role: String? = null,
)

data class Season(val id: String, val name: String, val index: Int?)

data class Episode(
    val id: String,
    val name: String,
    val season: Int?,
    val episode: Int?,
    val image: String?,
    val runtimeTicks: Long,
    val positionTicks: Long,
    val played: Boolean,
)

/** A chapter as the server sends it: [startSec] in seconds, [image] a same-origin path. */
data class Chapter(val startSec: Double, val name: String, val image: String?)

data class Person(val id: String, val name: String, val image: String?, val role: String?)

data class CastInfo(
    val name: String,
    val year: Int?,
    val rating: String?,
    val communityRating: Double?,
    val cast: List<Person>,
    val guests: List<Person>,
    val directors: List<Person>,
    val writers: List<Person>,
    val creators: List<Person>,
    val studios: List<String>,
    val genres: List<String>,
    /** the series of an episode (a person's titles leave it out) */
    val seriesId: String? = null,
)

data class Title(val id: String, val name: String, val type: String?, val year: Int?, val image: String?)

data class Bookmark(val id: String, val positionSec: Int, val note: String?)

data class SubResult(val id: String, val name: String, val provider: String, val downloads: Int)

/** The series' saved audio / subtitle choice; [anime] only when asked for (`?anime=1`). */
data class LangPref(val audio: String?, val subtitle: String?, val anime: Boolean)

/** A server answer that can fail with a status: [Err.error] is the body's `error` code, [Err.code] 0 on network trouble. */
sealed interface ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>
    data class Err(val code: Int, val error: String?) : ApiResult<Nothing>
}

sealed interface InfoAnswer {
    data class Ok(val info: PlaybackInfo) : InfoAnswer
    /** 429 max_streams: the account's stream limit is reached (server rule, never bypassed) */
    data class MaxStreams(val max: Int) : InfoAnswer
    /** another 4xx (not allowed for this profile, not found …): the web player shows its generic error */
    data object Refused : InfoAnswer
    /** 409 profile_changed / profile_required: the session's active profile is another one (or none) */
    data object ProfileMismatch : InfoAnswer
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
            code == 409 && j?.optString("error") in PROFILE_ERRORS -> InfoAnswer.ProfileMismatch
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

    /** One `/api/me` read: capability flags, post-play feature and role. Any trouble (or a missing flag) means "available". */
    fun caps(): ServerCaps {
        val me = get("/api/me") ?: return ServerCaps()
        val c = me.optJSONObject("server")?.optJSONObject("capabilities")
        fun flag(o: JSONObject?, k: String) = if (o == null || !o.has(k) || o.isNull(k)) true else o.optBoolean(k, true)
        val seg = c?.optJSONArray("segments")
        val role = (if (me.isNull("role")) null else me.optString("role").takeIf { it.isNotEmpty() })
            ?: me.optJSONObject("user")?.optString("role")?.takeIf { it.isNotEmpty() }
        return ServerCaps(
            chapters = flag(c, "chapters"),
            trickplay = flag(c, "trickplay"),
            subtitleSearch = flag(c, "subtitleSearch"),
            postplay = flag(me.optJSONObject("features"), "postplay"),
            segments = if (seg == null) ALL_SEGMENTS else (0 until seg.length()).mapNotNull { seg.optString(it).takeIf { s -> s.isNotEmpty() }?.lowercase() }.toSet(),
            role = role,
        )
    }

    /** Segment types this server offers skip buttons for (all four when not sent). */
    fun segmentTypes(): Set<String> = caps().segments

    /** The profile's preferences, or null when they could not be loaded (the caller keeps what it has: R2's stored sound mode). */
    fun prefs(): PlayerPrefs? {
        val p = get("/api/prefs")?.optJSONObject("prefs") ?: return null
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
            subtitleStyle = SubtitleStyle.parse(p.optJSONObject("subtitleStyle")),
            audioFx = p.optString("audioFx").takeIf { it in AUDIO_FX } ?: "off",
            animeOriginal = p.optBoolean("animeOriginal", false),
            postplay = p.optBoolean("postplay", true),
            spoilerProtection = p.optBoolean("spoilerProtection", false),
        )
    }

    /** This series' saved audio / subtitle choice (`GET /api/series/:id/langpref`; an episode id resolves to its series). [anime] also asks whether it is an anime. */
    fun langPref(seriesOrItem: String, anime: Boolean = false): LangPref {
        val j = get("/api/series/$seriesOrItem/langpref" + if (anime) "?anime=1" else "") ?: return LangPref(null, null, false)
        fun s(k: String) = if (j.isNull(k)) null else j.optString(k).takeIf { it.isNotEmpty() }
        return LangPref(s("audio"), s("subtitle"), j.optBoolean("anime", false))
    }

    /** Remembers the viewer's audio / subtitle pick for the series (`PUT /api/series/:id/langpref`), best effort. */
    fun saveLangPref(seriesId: String, audio: String? = null, subtitle: String? = null): Boolean = try {
        val b = JSONObject().also { o -> audio?.let { o.put("audio", it) }; subtitle?.let { o.put("subtitle", it) } }
        server.sendJson("/api/series/$seriesId/langpref", profileId, b, method = "PUT")?.first == 200
    } catch (_: IOException) {
        false
    }

    /** The profile's sound processing (`PUT /api/prefs/audiofx`), best effort. */
    fun saveAudioFx(mode: String): Boolean = send("PUT", "/api/prefs/audiofx", JSONObject().put("audioFx", mode)) is ApiResult.Ok

    fun seasons(seriesId: String): List<Season>? = get("/api/items/$seriesId/seasons")?.optJSONArray("items")?.let { a ->
        objects(a).mapNotNull { o ->
            val id = o.optString("id").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            Season(id, o.optString("name"), int(o, "indexNumber"))
        }
    }

    fun episodes(seriesId: String, seasonId: String?): List<Episode>? {
        val q = if (seasonId != null) "?seasonId=" + URLEncoder.encode(seasonId, "UTF-8") else ""
        return get("/api/items/$seriesId/episodes$q")?.optJSONArray("items")?.let { a ->
            objects(a).mapNotNull { o ->
                val id = o.optString("id").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                Episode(
                    id, o.optString("name"), int(o, "parentIndexNumber"), int(o, "indexNumber"), imageOf(o, 400),
                    o.optLong("runtimeTicks"), o.optLong("positionTicks"), o.optBoolean("played"),
                )
            }
        }
    }

    /** Raw chapters (`start` in seconds); normalising is up to the caller. Empty when the server has none. */
    fun chapters(itemId: String): List<Chapter>? = get("/api/items/$itemId/chapters")?.let { j ->
        val a = j.optJSONArray("chapters") ?: return@let emptyList()
        objects(a).mapNotNull { o ->
            val s = o.optDouble("start", Double.NaN)
            if (s.isNaN()) null else Chapter(s, o.optString("name"), str(o, "image"))
        }
    }

    fun castInfo(itemId: String): CastInfo? {
        if (!validId(itemId)) return null
        val j = get("/api/items/$itemId/castinfo") ?: return null
        val it = j.optJSONObject("item") ?: return null
        fun people(k: String) = j.optJSONArray(k)?.let { a -> objects(a).mapNotNull(::parsePerson) } ?: emptyList()
        fun strings(k: String) = j.optJSONArray(k)?.let { a -> (0 until a.length()).mapNotNull { i -> a.optString(i).takeIf { s -> s.isNotEmpty() } } } ?: emptyList()
        return CastInfo(
            name = it.optString("name"),
            year = int(it, "year"),
            rating = str(it, "rating"),
            communityRating = if (it.has("communityRating") && !it.isNull("communityRating")) it.optDouble("communityRating") else null,
            cast = people("cast"), guests = people("guests"), directors = people("directors"), writers = people("writers"), creators = people("creators"),
            studios = strings("studios"), genres = strings("genres"),
            seriesId = str(it, "seriesId"),
        )
    }

    /** The titles (movies, series) a person appears in (`GET /api/people/:id`); 404 = none visible to this profile (empty), null = failed. */
    fun personTitles(personId: String): List<Title>? {
        if (!validId(personId)) return null
        val j = try {
            val (code, body) = server.getJson("/api/people/$personId", profileId)
            if (code == 404) return emptyList()
            if (code == 200) body else null
        } catch (e: SessionExpired) {
            throw e
        } catch (_: IOException) {
            null
        }
        return titles(j)
    }

    fun similar(itemId: String): List<Title>? = titles(get("/api/items/$itemId/similar"))

    fun bookmarks(itemId: String): List<Bookmark>? = get("/api/bookmarks?itemId=" + URLEncoder.encode(itemId, "UTF-8"))?.optJSONArray("bookmarks")?.let { a ->
        objects(a).mapNotNull { o ->
            val id = o.optString("id").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            Bookmark(id, o.optInt("position"), str(o, "note"))
        }
    }

    /** `POST /api/bookmarks`: the new bookmark's id; 409 `too_many_bookmarks` when the profile's 500 are used. */
    fun addBookmark(itemId: String, positionSec: Int, note: String?): ApiResult<String> {
        val b = JSONObject().put("itemId", itemId).put("position", positionSec)
        note?.takeIf { it.isNotEmpty() }?.let { b.put("note", it) }
        return when (val r = send("POST", "/api/bookmarks", b)) {
            is ApiResult.Err -> r
            is ApiResult.Ok -> r.value.optString("id").takeIf { it.isNotEmpty() }?.let { ApiResult.Ok(it) } ?: ApiResult.Err(200, null)
        }
    }

    fun removeBookmark(id: String): Boolean = send("DELETE", "/api/bookmarks/" + URLEncoder.encode(id, "UTF-8"), JSONObject()) is ApiResult.Ok

    /** `GET /api/items/:id/subtitles/search?lang=<3 letters>`; 403 for guests, 502 `subtitle_provider_unavailable`. */
    fun searchSubtitles(itemId: String, lang3: String): ApiResult<List<SubResult>> =
        when (val r = request("GET", "/api/items/$itemId/subtitles/search?lang=" + URLEncoder.encode(lang3, "UTF-8"), null)) {
            is ApiResult.Err -> r
            is ApiResult.Ok -> ApiResult.Ok(
                r.value.optJSONArray("results")?.let { a ->
                    objects(a).mapNotNull { o ->
                        val id = o.optString("id").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                        SubResult(id, o.optString("name"), o.optString("provider"), o.optInt("downloads"))
                    }
                } ?: emptyList(),
            )
        }

    fun downloadSubtitle(itemId: String, subtitleId: String): ApiResult<Unit> =
        when (val r = send("POST", "/api/items/$itemId/subtitles/download", JSONObject().put("subtitleId", subtitleId))) {
            is ApiResult.Err -> r
            is ApiResult.Ok -> ApiResult.Ok(Unit)
        }

    /** The post-play answer, raw (parsed by the post-play screen); null when off, not allowed or failing. */
    fun postplay(itemId: String): JSONObject? = get("/api/items/$itemId/postplay")

    /** `POST /api/postplay/event`, best effort. */
    fun postplayEvent(body: JSONObject) {
        try { server.sendJson("/api/postplay/event", profileId, body) } catch (_: IOException) { }
    }

    private fun get(path: String): JSONObject? = try {
        val (code, j) = server.getJson(path, profileId)
        if (code == 200) j else null
    } catch (e: SessionExpired) {
        throw e
    } catch (_: IOException) {
        null
    }

    private fun send(method: String, path: String, body: JSONObject): ApiResult<JSONObject> = request(method, path, body)

    /** GET (body null) or a CSRF-protected write: 200 → Ok(body or {}), else Err(status, body.error); network trouble → Err(0, null). */
    private fun request(method: String, path: String, body: JSONObject?): ApiResult<JSONObject> = try {
        val r = if (body == null) server.getJson(path, profileId) else server.sendJson(path, profileId, body, method = method)
        when {
            r == null -> ApiResult.Err(0, null)
            r.first == 200 -> ApiResult.Ok(r.second ?: JSONObject())
            else -> ApiResult.Err(r.first, r.second?.optString("error")?.takeIf { it.isNotEmpty() })
        }
    } catch (e: SessionExpired) {
        throw e
    } catch (_: IOException) {
        ApiResult.Err(0, null)
    }

    private fun titles(j: JSONObject?): List<Title>? = j?.optJSONArray("items")?.let { a ->
        objects(a).mapNotNull { o ->
            val id = o.optString("id").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            Title(id, o.optString("name"), str(o, "type"), int(o, "year"), imageOf(o, 300))
        }
    }

    private fun parsePerson(o: JSONObject): Person? {
        val id = o.optString("id").takeIf { it.isNotEmpty() } ?: return null
        return Person(id, o.optString("name"), imageOf(o, 300), str(o, "role"))
    }

    companion object {
        private val ID = Regex("[A-Za-z0-9_-]{1,64}")
        private fun validId(id: String) = ID.matches(id)

        val ALL_SEGMENTS = setOf("intro", "outro", "recap", "preview")
        private val AUDIO_FX = setOf("off", "voices", "night", "both")
        private val PROFILE_ERRORS = setOf("profile_changed", "profile_required")

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
                trickplay = j.optJSONObject("trickplay")?.let(::parseTrickplay),
            )
        }

        private fun parseTrickplay(o: JSONObject): TrickplayInfo? {
            val url = o.optString("url").takeIf { it.isNotEmpty() } ?: return null
            val w = o.optInt("width"); val h = o.optInt("height"); val tw = o.optInt("tileWidth"); val th = o.optInt("tileHeight")
            val count = o.optInt("count"); val interval = o.optLong("interval")
            if (w <= 0 || h <= 0 || tw <= 0 || th <= 0 || count <= 0 || interval <= 0) return null
            return TrickplayInfo(w, h, tw, th, count, interval, url)
        }

        private fun str(o: JSONObject, k: String) = if (o.isNull(k)) null else o.optString(k).takeIf { it.isNotEmpty() }

        private fun int(o: JSONObject, k: String) = if (o.has(k) && !o.isNull(k)) o.optInt(k) else null

        /** The item's poster path when the server says it has one (`image: true`), like web `img()`. */
        internal fun imageOf(o: JSONObject, width: Int): String? =
            if (o.optBoolean("image", false)) o.optString("id").takeIf { it.isNotEmpty() }?.let { "/media/Items/$it/Images/Primary?maxWidth=$width&quality=85" } else null

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
