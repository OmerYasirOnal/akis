# Round-2 kontrol & geliştirme menüsü (2026-06-07)

> Şu an koşan işler: dev-review-loop (PR #127-129 ✅ açıldı, "ship"), frontend canlı UX/i18n/tema review'ü,
> canlı-kutu drift kontrolü, public-repo güvenlik taraması, 5 direkt-main commit'in correctness review'ü,
> lokal tam-süit merge gate'i. Aşağıdakiler bunların **kapsamadığı**, sıradaki tur için aday kontroller.

## A0. Güvenlik taraması bulguları (2026-06-07 sweep — secrets temiz, auth sağlam, threat-model dürüst)

0a. **(MED, en büyük getiri) fastify v4→v5 upgrade** — backend `fastify@4.29.1` terk edilmiş hat; 3 runtime HIGH
    (Content-Type tab-parse, fast-uri path-traversal/host-confusion) yalnız v5'te yamalı. `@fastify/static`/`@fastify/multipart`
    major'larıyla birlikte tek bounded görev; migration + yeşil süit şart.
0b. **(LOW, dev-only) dev-tooling bump** — vitest ≥4.1.0 (CRITICAL temizler), vite ≥6.4.2, esbuild ≥0.25.0; shipped değil.
0c. **(LOW, multi-user'a kalsın) OAuth connectState'e single-use nonce store** — ≤600s TTL içinde replay penceresini kapatır.

## A. Süreç riski — tek en büyük madde

1. **CI'yı geri getir (billing fix veya alternatif)** — şu an her merge'in tek güvencesi elle koşulan lokal gate.
   Billing çözülemiyorsa: ücretsiz alternatif runner (Cirrus/Buildjet) veya OCI kutusunda self-hosted runner
   (dikkat: public repo + self-hosted runner = PR'dan kod çalıştırma riski → yalnız `main`/etiketli branch'lerde koştur).

## B. Dayanıklılık & operasyon (canlı kutu)

2. **Restart-durability tatbikatı** — build ortasında container'ı öldür: session/audit ledger/preview'lar nasıl toparlanıyor?
3. **Postgres-down davranışı** — db çökünce API'nin fail-closed olduğunu ve veri kaybetmediğini doğrula.
4. **Yedekleme** — kutuda pg_dump cron'u + restore tatbikatı (hiç yok şu an; tek-kullanıcı verisi bile kaybolmamalı).
5. **Master-key rotasyon tatbikatı** — `AKIS_MASTER` döndüğünde KeyStore/GitHub/Atlassian store'ların fail-closed
   "absent" okuduğunu CANLIDA doğrula (testte var, kutuda denenmedi).
6. **Log hijyeni** — kutu loglarında secret/token/e-posta sızıntısı taraması.
7. **HTTPS** — akisflow.com (VCN 80/443 açılınca; owner'da). Cookie'ler `secure` olana dek tarayıcı uyarısı sürer.
8. **İzleme** — basit uptime/health cron + disk doluluk alarmı (956MB kutu; docker image birikimi riski).
8b. **Image provenance label'ı** — deploy build'ine `org.opencontainers.image.revision=<git sha>` etiketi
    (2026-06-07 drift kontrolü kaynak inceleyerek yapılmak zorunda kaldı; etiketle tek `docker inspect` olur).

## C. Performans

9. **Lighthouse + bundle audit** — chrome-devtools MCP `lighthouse_audit` ile studio skorları; vite bundle analizi.
10. **SSE yük testi** — uzun build'de yüzlerce event altında FE coalescer + BE bus belleği; kutu mem-capped.
11. **#15 Docker -190MB** — bilinen backlog; kutudaki disk/çekme süresine direkt etki.

## D. Test kalitesi

12. **Coverage'ın kör %14'ü** — ~%86 satır coverage'ın DIŞINDA kalan dosyaların listesi: gate/auth/key dosyası var mı?
13. **Golden-eval retrieval gate (M1'den kalan tek açık exit kriteri)** — ≥20 query→chunk çifti, top-5 ≥%80.
14. **Mutation testing (yalnız gates/)** — 4 gate + externalWriteGate üzerinde Stryker: testler gerçekten kilitliyor mu?
15. **AKIS_REAL_TESTS=1 tam-gerçek e2e** — en güncel main'de full-real pipeline'ın (gerçek verify) yeşil kaldığını periyodik doğrula.

## E. Frontend profesyonelleşme (UX review'ün bulgularına ek)

16. **Erişilebilirlik (a11y)** — axe taraması, klavye navigasyonu, aria-label'lar, kontrast (WCAG AA).
17. **Cross-browser** — Safari + Firefox'ta studio (SSE/EventSource davranış farkları bilinen tuzak).
18. **Yeni-kullanıcı ilk-çalıştırma akışı** — temiz profille: kayıt kapalı mesajı → giriş → ilk build → trust card;
    sürtünme noktaları.

## F. Self-host & topluluk (repo public olduğu için)

19. **Temiz-makine self-host testi** — SELF_HOSTING.md'yi kelimesi kelimesine temiz bir VM/container'da uygula; ilk
    takıldığın yer = dokümandaki ilk yalan.
20. **Lisans/NOTICE denetimi** — Apache-2.0 + bağımlılık lisans uyumu; CONTRIBUTING'in gerçek akışla tutarlılığı.
21. **Issue/PR şablonları + SECURITY.md iletişim kanalı** — dış katkı/rapor gelirse hazır mıyız?

## G. Bilinen backlog (tamamlanacak işler)

22. **Atlassian wiring slice'ları** — OAuth route'ları (bu turdan düştü), proposal akışı, agent wiring, FE connect UI;
    her biri PR + gate-keeper zorunlu (4 taşınan not: allowlist ✅ #128'de, UI-digest→mint, owner-scoping, canonicalization ✅ #127'de).
    2026-06-07 correctness review 2 LOW daha ekledi (wiring'den önce kapat): (a) `HttpMcpTransport.ts:155` bearerFetch
    header-spread'i `Headers` instance'ını düşürür → `new Headers(init?.headers)` normalizasyonu; (b) `externalWriteGate.ts:107`
    `{...target, ...payload}` anahtar çakışması footgun'u → mint'te disjoint-key assert.
23. **Complexity/coupling audit** — bu turdan düşen 5. görev; en bağımlı backend sınıflarının davranış-koruyucu sadeleştirmesi.
24. **#18 kalanı** — free-quota sayısı (owner kararı) + kullanım analitiği UI.
25. **ANN ranking path** — pgvector ivfflat var ama ranking hâlâ JS cosine (ölçek gelince).
26. **Repo temizliği** — biten `wf/*` ve `worktree-*` branch'leri (lokal+remote), `docs/NEXT.md` güncelleme (2026-06-03'te kaldı).

## Önerilen sıra (koşan işler bitince)

1. Koşan 6 işin bulgularını birleştir → HIGH'ları tek dev-review-loop turunda kapat
2. A1 (CI) + B4 (yedek) + B2 (restart tatbikatı) — operasyonel taban
3. G22 (Atlassian wiring, slice slice) + G23 (complexity audit)
4. D12-D14 (test kalitesi) ve E16-E18 (FE profesyonelleşme) — UX review bulgularıyla birlikte
5. F19 (temiz-makine self-host) — GTM'den önce son dürüstlük kontrolü
