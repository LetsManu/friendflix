# PR 1b smoke test on a real Docker host (for local)

Run on a throwaway test stack in WSL Docker. Use placeholder config only: `PUBLIC_URL=https://friend.example.com`, a fresh `.env` from `.env.example` with generated secrets, and no real media server needed for these steps. Never paste secrets into the board.
"Old" = `compose.prod.yaml` from `origin/main` before 1b (commit 21a2e0d6). "New" = from `claude/wip-livetv-1b`. Build the images locally from `claude/wip-livetv-1b` (`docker compose -f compose.dev.yaml build` or `docker build` per service) and tag them as the compose files expect (FF_TAG=local). There is no updater self-update from GHCR here, so steps that need the GHCR registry or a published tag: run what you can, and mark the rest "n/a (needs published image)".
Report per step: pass, fail (with the shortest decisive log line, no secrets) or n/a.

## Owner smoke test on a real Docker host (updated)

Run from the stack directory with the updater stack (`compose.prod.yaml` plus your overlays). `P` is the compose project name (e.g. `friendflix`), `R` is `ghcr.io/letsmanu/friendflix-livetv`.

1. **Old compose files, new images.**
   - Update to the 1b build through *Admin → Update*.
   - Expect: succeeded. This proves that `ps` without names, with `--profile livetv`, works on files without livetv.
   - Then, inside the updater:
     ```
     docker compose -f compose.prod.yaml exec updater docker compose --project-directory "$PWD" -f "$PWD/compose.prod.yaml" -p P --profile updater --profile livetv --ansi never ps --all --format json | head -c 300; echo " exit=$?"
     ```

1a. **Old compose files keep working (re-review C1).** Still on the old `compose.prod.yaml` (from before 1b), after the update of step 1 and once more after `docker compose -f compose.prod.yaml up -d`:
    ```
    docker compose -f compose.prod.yaml logs bootstrap | tail -8
    docker compose -f compose.prod.yaml ps -a bootstrap --format '{{.State}} {{.Status}}'
    ```
    - Expect a line `bootstrap: livetv_key: skipped (no livetv volume)`, the other files `kept`, and the bootstrap container `exited` with `Exited (0)`.
    - Backend, gateway and web are up. The update in step 1 ended `succeeded`, not `restart_failed` / rolled back.

2. **Updater too old (I3a).**
   - Do not update the updater yet. Open *Admin → Live-TV*.
   - Expect: no *Live-TV aktivieren* button, the line "Dieser Updater kennt Live-TV noch nicht …", and a button *Erst den Updater aktualisieren* that opens *Admin → Update*.

3. **Old compose files (I3b).**
   - *Admin → Update → Updater aktualisieren*, then *Live-TV aktivieren* with the old compose.prod.yaml.
   - Expect: the job fails at "pull" with "Deine compose.prod.yaml stammt von vor Live-TV … docker compose up -d …". Nothing is pulled or started.

4. **Refreshed compose.prod.yaml without `up -d` (I3c).**
   - Replace compose.prod.yaml with the release's. Press *Live-TV aktivieren*.
   - Expect: "Backend und Gateway hängen noch nicht im Netz livetv …" (`network_missing`); nothing pulled.
   - Then press *Update now*. Expect: succeeded, no `config_mismatch`.
   - Then:
     ```
     docker network inspect P_livetv --format '{{range .Containers}}{{.Name}} {{end}}'
     ```
     Expect the backend and gateway containers (the update attached them).
   - Without an update, `docker compose -f compose.prod.yaml up -d` does the same.

5. **The key volume (I1).** After any `up -d` or update with the new files (bootstrap's log now says `livetv_key: generated`, later `kept`):
   ```
   docker run --rm -v P_bootstrap-livetv:/v:ro alpine sh -c 'ls -ln /v; wc -c < /v/livetv_key'
   ```
   - Expect `livetv_key`, owner `0 10001`, `-r--r-----`, 64 bytes.
   - Do not print the file. It is a key, though only livetv's.

6. **Enable through the UI.**
   - Expect the steps, then "Live-TV läuft." within about 10 s. Then run:
     ```
     docker compose -f compose.prod.yaml --profile livetv ps livetv; docker inspect -f '{{.State.Health.Status}} {{.Config.User}}' P-livetv-1; docker compose -f compose.prod.yaml --profile livetv logs livetv | tail -3
     docker compose -f compose.prod.yaml --profile livetv exec livetv sh -c 'env | grep -c INTERNAL_SECRET; ls /run/friendflix-gateway 2>&1 | head -1'
     ```
   - Expect: healthy; user 10001; a "listening on :8090" line and no "INTERNAL_SECRET is set" line; `0`; and "No such file or directory".

7. **Proof of key from the backend (I2).**
   ```
   docker compose -f compose.prod.yaml exec backend node -e "fetch('http://livetv:8090/healthz?n=0123456789abcdef0123456789abcdef').then(r=>r.json()).then(j=>console.log(Object.keys(j).join(',')))"
   ```
   - Expect `ok,api,version,bootId,proof`.

8. **`--pull never` beats `pull_policy: always`.**
   ```
   docker image tag R:sha-<running7> R:smoke-local && FF_TAG=smoke-local docker compose -f compose.prod.yaml --profile livetv up -d --no-deps --pull never livetv
   ```
   - Expect: recreated from the local tag, with no "pulling" and no "manifest unknown".
   - Afterwards:
     ```
     docker image rm R:smoke-local
     ```
     Then press *Live-TV aktivieren* once to put the verified tag back.

9. **One-off label.**
   ```
   docker compose -f compose.prod.yaml --profile livetv run -d --no-deps --name lt-oneoff livetv node -e "setTimeout(()=>{},120000)"; docker compose -f compose.prod.yaml --profile livetv ps --all --format json | grep -o '"Name":"[^"]*"\|com.docker.compose.oneoff=[A-Za-z]*'
   ```
   - Expect `oneoff=True` for lt-oneoff and `False` for P-livetv-1.
   - *Admin → Live-TV* still shows the service.
   - Afterwards: `docker rm -f lt-oneoff`.

10. **`image ls` exact match, through the proxy.**
    ```
    docker image tag R:sha-<running7> R-extra:smoke; docker compose -f compose.prod.yaml exec updater docker image ls --format '{{.Repository}}:{{.Tag}}' R
    ```
    - Expect no `-extra` row.
    - Afterwards: `docker image rm R-extra:smoke`.

11. **Removal through the proxy (I4).**
    - *Live-TV ausschalten…* with both boxes ticked.
    - Expect: the job succeeds; the page shows "Live-TV wird ausgeschaltet …" (never "Live-TV läuft.") until detection agrees, then the offer card. The nav row gets its *optional* chip back.
    - Then run:
      ```
      docker image ls R; docker volume ls --format '{{.Name}}' | grep -E 'livetv-cache|recordings|bootstrap-livetv'
      ```
    - Expect: no livetv images, no `P_livetv-cache`, and `P_recordings` and `P_bootstrap-livetv` still present (the key volume belongs to bootstrap).

12. **GPU facts (I5).** Without any overlay, after re-enabling:
    ```
    docker compose -f compose.prod.yaml --profile livetv exec livetv sh -c '/usr/lib/jellyfin-ffmpeg/ffmpeg -hide_banner -encoders | grep -E "h264_(nvenc|qsv|vaapi)"; ls /dev/nvidiactl /dev/dri 2>&1'
    ```
    - nvenc and qsv may well be listed (compiled in), but `/dev/nvidiactl` must be absent.
    - On an NVIDIA host whose Jellyfin uses nvenc, *Admin → Live-TV* must show "… compose.livetv-nvidia.yaml hinzufügen …", not "auch für Live-TV aktiv".
    - With `-f compose.livetv-nvidia.yaml` added and `up -d`, it must show the "both" line.

13. **Name fall-through and impostor (I2).** With the profile off:
    ```
    docker compose -f compose.prod.yaml exec backend node -e "require('dns').lookup('livetv',(e,a)=>console.log(e?e.code:a))"
    ```
    - Expect `ENOTFOUND`.
    - Optional impostor check, profile off and livetv removed:
      ```
      docker run --rm -d --name fake-livetv --network P_livetv --network-alias livetv node:26-alpine node -e "require('http').createServer((q,s)=>s.end(JSON.stringify({ok:true,api:1,version:null,bootId:'0123456789abcdef'}))).listen(8090)"
      ```
    - Wait 60 s. Expect: *Admin → Live-TV* still shows the offer (not installed), and the backend logs once "livetv: health answer with a missing proof of key …".
    - Afterwards: `docker rm -f fake-livetv`.

14. **SRT bind default (M11).**
    ```
    docker port P-livetv-1
    ```
    - Expect `9000/udp -> 127.0.0.1:9000` … (no `0.0.0.0`) unless `LIVETV_SRT_BIND` is set in `.env`.

