# Desktop player: session cookie and HTTP redirects

Status: November 2026. Question from a security review: the Windows app hands mpv the session cookie in
`http-header-fields` (`desktop/core/src/session.rs`, `set_headers`). Does a redirect on a media URL make the player send
that cookie to another host, or to plain http?

Answer: yes on FFmpeg's http protocol; libcurl (mpv's first choice in the pinned build) drops the cookie but forwards the
other custom headers. Fixed by turning redirects off for the player (`NO_REDIRECTS` in `session.rs`).

## The pinned build

`desktop/player/mpv.lock`: shinchiro `mpv-x86_64-20261018-git-01e2533f31.7z`, SHA-256 matched the lock. From
`strings mpv.exe`:

- `mpv v0.41.0-1205-g01e2533f3`, configured with `-Dlibcurl=enabled`; libcurl `8.22.0-DEV`.
- FFmpeg `N-127617-g94cba3150` (FFmpeg master of 2026-10-17, libavformat 63.10.100).
- Both redirect options are in the binary: `max-redirects` (mpv's curl group) and FFmpeg's
  `Maximum number of redirects`.

mpv at that commit (`stream/stream_curl.c`) enables its libcurl backend by default when libavformat is at least
62.15.101, so this build loads `http(s)://` with libcurl first and falls back to FFmpeg's http protocol when curl is off,
fails to start ("libcurl failed …, falling back to lavf") or does not handle a nested URL.

## FFmpeg's http protocol (`libavformat/http.c`, master of 2026-11)

- `http_connect` appends the custom `headers` option to every request it builds, with no check of host or scheme.
- `http_open_cnx` follows 301, 302, 303, 307 and 308 to `Location` (made absolute against the current URL), any host,
  any scheme, and `goto redo` sends the same `headers` again.
- The limit is the `max_redirects` option (default 8), added by FFmpeg commit ba3639bc9 "avformat/http: allow adjusting
  the redirect limit" (2026-02-17, first in n8.1; not in n8.0 or n8.0.1). With `max_redirects=0` the first redirect
  fails with EIO before any request goes to the new location. Older FFmpeg has no such option and accepts it silently.
- The HLS / DASH demuxers copy only `headers`, `user_agent`, `cookies`, `http_proxy`, `referer`, `rw_timeout`, `icy`
  and `prefer_libcurl` into their segment requests (`ffio_copy_url_options`), not `max_redirects`. mpv adds its own
  options to every nested open (`nested_io_open`, `demuxer-lavf-propagate-opts`, on by default), and for `hls` / `dash`
  (`nested_network`) those include `stream-lavf-o`. So `stream-lavf-o=max_redirects=0` reaches segment requests too.
- There is no FFmpeg `follow` option; `location` is an export-only option (the final URL), and the `reconnect*` options
  do not affect redirects.

## mpv's libcurl backend (`stream/stream_curl.c` at 01e2533f3)

- `CURLOPT_FOLLOWLOCATION` on, `CURLOPT_MAXREDIRS` from `--curl-max-redirects` (default 16, range 0–100);
  `http-header-fields` become `CURLOPT_HTTPHEADER`; `CURLOPT_UNRESTRICTED_AUTH` is not set.
- libcurl (`lib/http.c`, custom headers) drops a custom `Authorization` or `Cookie` header when a followed request goes
  to another origin (`Curl_auth_allowed_to_host`), but sends every other custom header, so `x-ff-profile` follows the
  redirect.
- `curl-max-redirects` is read when each stream opens, including the nested (HLS) opens, so setting it over IPC before
  `loadfile` applies.

## Local check

Two Python servers: 127.0.0.1:8701 answers every GET with `302 Location: http://127.0.0.2:8702/…`; the second records
whether a request carried the test cookie. Requests sent with `Cookie: ff_sid=test-only` and `x-ff-profile: p1`:

| Client | Second host received |
|---|---|
| ffmpeg 6.1 `-headers` (lavf http.c) | the cookie and `x-ff-profile` |
| curl 8.5 `-L -H` | `x-ff-profile`, no cookie |
| curl 8.5 `-L --max-redirs 0` | no request (exit 47) |

The pinned FFmpeg (8.1+) could not be run here, so its `max_redirects=0` is confirmed from the source above, not by a
run.

## Fix and alternatives

- Chosen: no redirects for the player. Before the headers, `set_headers` sets `curl-max-redirects=0` and
  `stream-lavf-o=max_redirects=0`; when mpv refuses either one, no header is set and the title fails with the generic
  error. Nothing legitimate breaks: the gateway answers an upstream 3xx with 502, and every URL the player loads is
  checked against the server origin first (`Origin::resolve`).
- Not needed now: a short-lived, path-scoped media token. The backend has one for casting (`/media/c/<token>/…`,
  `backend/src/routes/cast.ts`), tied to the cast permission and receiver flow; reusing it for the desktop player would
  be a larger change and still leaves the cookie for the player's own server calls.
- Not needed: refusing only cross-origin redirects; no redirect is expected at all.
- Re-pinning mpv must keep both options (see `mpv.lock`).
- TLS: `--tls-verify` defaults to yes in this build (libcurl), but to no on builds without libcurl and with libavformat
  older than 63.0.100. The app therefore passes `--tls-verify=yes` on the command line (`desktop/app/src/player/mpv.rs`,
  `args`), so the cookie is never sent to `https://friend.example.com` over an unverified connection, whatever build is
  pinned.
