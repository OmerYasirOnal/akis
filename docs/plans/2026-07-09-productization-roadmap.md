# AKIS ürünleştirme yol haritası (2026-07-09)

> **Bağlam:** Bitirme projesi TAMAMLANDI — savunma yapıldı, rapor **93/100**, ders notu **AA**.
> `v1.0.0` full self-host release GHCR'da yayında (digest
> `sha256:bdf59219…`), main CI yeşil, açık PR yok. Owner kararı (2026-07-09 oturumu):
> **repo bundan sonra ürünleştirme hattında ilerliyor** — akademik teslim değil, gerçek
> kullanıcıya değer üreten bir ürün hedefi.
>
> Önceki kuyruk (`2026-06-10-demo-ready-plan.md`) kapandı; bu doküman onun halefidir.
> Çalışma disiplini değişmedi: `CLAUDE.md` "Working method" (izole worktree, çift adversarial
> review, fail-first test, tam yeşil süitler, owner merge'i, 4 gate kutsal).

## İlke: doküman değil kod konuşur

Demo-dönemi dokümanları kodun gerisinde kaldı (kanıt: A2.1 "açık" görünüyordu ama
`deliverySlug.ts` + gerçek `RealGitHubAdapter.createRepo` + Settings'teki
"connect yalnız authenticate eder, her proje kendi private reposunu alır" kopyası gemide).
Bu yüzden **her fazın ilk adımı, o fazın kalemlerini koddan doğrulamaktır** — bayat bir
doküman maddesini yeniden "yapmak" yok.

## Faz 0 — Savunma-sonrası temizlik (bu oturumda başladı)

- [x] SessionStart hook'u: rapor tooling'i varsayılan KAPALI (`AKIS_REPORT_TOOLING=1` ile opt-in).
- [x] `CLAUDE.md`: rapor bölümü "DELIVERED" olarak güncellendi; güncel kuyruk işaretçisi bu dokümana çevrildi.
- [x] `MEMORY.md`: faz pivotu (🎓 2026-07-09) en üste eklendi.
- [x] `2026-06-10-demo-ready-plan.md`'ye kapanış banner'ı.
- [x] **Issue #4 senkronu (2026-07-09):** kod-düzeyi ground-truth taramasıyla M0–M5'in tamamı
      gemide doğrulandı (alt-issue #5–#10 zaten kapalıydı; kutular bayat kalmış). #4 gövdesi
      kanıtla güncellenip KAPATILDI; iki gerçek artık **#168**'e bölündü (agent-output ingest
      kaynağı + ANN ranking yolu). `docs/roadmap.md`'deki "agent-output" abartısı düzeltildi.
- [ ] `HANDOFF.md` zaten "historical" işaretli — dokunma. `docs/plans/` altındaki diğer
      demo-dönemi dokümanlarına dokunma (tarihsel kayıt).

## Faz 1 — Ground-truth taraması + küçük ürün pürüzleri

**Tarama YAPILDI (2026-07-09, 5 paralel scout, hepsi `file:line` kanıtlı):**

| Kalem | Durum | Not |
|---|---|---|
| B2 Scribe idle | ✅ GEMİDE | Sentetik `agent_start/end` (`Orchestrator.ts:290/297`) + roster fallback (`AgentRoster.tsx:34-40`) |
| P0-2.1 digest-skip | ✅ GEMİDE | `PreviewStartCoordinator.restart` aynı digest'te restart'ı atlar (`preview.routes.ts:144-156`) |
| P0-2.2 non-evicting prewarm | ✅ GEMİDE | `evict:'never'` + `atCapacity()` reddi (`PreviewRegistry.ts:240-249`) |
| P0-2.3 eviction-yarımı | ✅ GEMİDE | launch-token sahiplik şeması her await sınırında (`PreviewRegistry.ts:167-175`) |
| B1 sticky bar | ➖ FİİLEN KAPALI | Birebir bar hiç merge edilmedi ama asıl şikâyet auto-scroll-to-run ile çözüldü (`AkisChat.tsx:430-437`); bar artık opsiyonel cila |
| B7 yeni-sohbet UX | ➖ KARAR (i) GEÇERLİ | Aktif sohbet korunur + teal "Yeni geliştirme"; karşılama ekranı (ii) istenirse Faz 4 |
| B5 shared-key dürüstlüğü | ✅ KAPANDI (`ca57103`) | `ProviderKeys` artık `keySource:'shared'`'da dürüst "Paylaşımlı sunucu anahtarı — kendi anahtarını eklersen o kullanılır" kopyasını basıyor (TR/EN `settings.keys.sharedKey`) |
| B4b analytics ham başlık | ✅ KAPANDI (`ca57103`) | `AnalyticsPage` per-run satırları History'nin `ideaTitle()` çözücüsünü kullanıyor; tooltip ham fikri koruyor |
| B4a analytics bucketing | 🔴 AÇIK (owner kararı ister) | verified-ama-cancelled ne `done` ne `verifiedRuns`'a giriyor ama `verify` istatistiklerine giriyor (`StatsCollector.ts:37-64`); karar: ayrı sayaç mı, `verifiedRuns`'a dahil mi? + `StatsCollector` testi (bugün yok) |
| B9 koşulsuz poll | ✅ KAPANDI (`ca57103`) | Poll yalnız canlı build'de (`specChipStatus==='building'`) veya GÖRÜNÜR kart varken; mount + live-kenar yüklemeleri reopen/park penceresini kapatıyor. Review LOW'u da kapandı: gate ham `writes` listesine değil görünür kart kümesine bakıyor |
| B6 i18n süpürmesi | 🔴 AÇIK (yapısal) | İki sızıntı sınıfı: (a) her sayfadaki ham `"${code}: ${message}"` fallback'i — en kötüsü auth sayfaları (`Login.tsx:43`, `Signup.tsx:28`, parola akışları); (b) `kind:'error'` SSE → `ErrorBubble` yolunda SIFIR i18n eşlemesi (push/critic/pipeline canlı hataları hep İngilizce; `chatModel.ts:174` → `ChatThread.tsx:306`). BE locale bilmiyor → çözüm kod→katalog eşlemesi (recovery.* kalıbı örnek) |

**Açık kalanların kapanış sırası:**
1. ~~PR-a: B5 + B4b~~ ✅ + ~~PR-b: B9~~ ✅ — tek pakette gemiye alındı (`ca57103`,
   branch `claude/session-planning-dcbl56`): fail-first testler (5 yeni), typecheck 3/3,
   BE 1728/5-skip, FE 751/751 (TR/EN parity dahil). Adversarial review: gate-keeper 0 bulgu;
   reviewer'ın 1 doğrulanmış LOW'u (poll gate'inin ham listeye bakması) aynı pakette kapatıldı,
   1 bulgusu skeptik tarafından çürütüldü.
2. ~~PR-c: B4a~~ ✅ (`ce5ad50`) — `verifiedRuns` artık passed `verify` olayında sayılıyor
   ("doğrulama gerçekten geçti"; `done` = "ship edildi" olarak kalır). Owner kararı cevapsız
   kaldığı için önerilen varsayılan uygulandı — merge'de tersine çevrilebilir (tek satır +
   testler). Not: scout'un "StatsCollector testi yok" iddiası yanlıştı; mevcut test korunup
   4 yeni fail-first test eklendi. BE 1732/5-skip yeşil.
3. **B6 iki alt pakete bölündü:**
   - ~~B6-i (auth yüzeyleri)~~ ✅ (`eec2c99`) — backend auth hataları ZATEN sabit makine kodu
     taşıyormuş (BadCredentials/WeakPassword/EmailTaken/BadToken/…); salt-FE `authErrorKey()`
     eşleyicisi (OAUTH_ERROR_KEYS kalıbı) 5 auth sayfasına uygulandı, `auth.err.*` TR/EN
     anahtarları eklendi, bilinmeyen kod → generic (ham İngilizce asla render edilmez).
     FE 754/754 yeşil.
   - ~~B6-ii (error-SSE lokalizasyonu)~~ ✅ (`9eed9a1`) — `error` olayında `code?` ZATEN
     vardı ve 4 emit'in 3'ü kod taşıyordu; yalnız push emit'ine ADDITIVE `code:'PushFailed'`
     eklendi (mesaj byte-identical). FE: `runError.ts` kod→başlık eşleyicisi
     (PushFailed/RunFailed/CRITIC_*), ErrorBubble lokalize başlık + ham teknik ayrıntı;
     kodsuz/eski olaylar birebir eski görünümde. Gate-keeper **0 bulgu** (tüm error-tüketici
     yüzeyleri izlendi); reviewer temiz + 1 PRE-EXISTING LOW notu (aşağıda).
     BE 1733/5-skip + FE 760/760 yeşil.

**Faz 1 KAPANDI.** Not düşülen (fix'lenmemiş) gözlemler:
- *verifiedRuns > done* artık tasarım gereği mümkün (B4a semantiği) — dashboard'da kafa
  karıştırırsa etiket açıklaması eklenebilir.
- *Critic çifte balonu (pre-existing LOW):* code-review critic hatasında hem `CRITIC_*` hem
  sarmalayıcı `RunFailed` olayı yayılıyor → 2 balon (B6-ii öncesi de 2 ham balondu). Önerilen
  fix `kickRun` catch'inde `CriticFailedError`'da RunFailed emit'ini atlamak — ama bu bir
  emisyonu KALDIRIR (additive-only invariantı) → owner onayı ister.
- *Auth-dışı `"${code}: ${message}"` fallback'leri* (`AkisChat.tsx:484`, `actionError.ts:30`,
  ExternalWriteCard/AgentWriteProposals): bilinen kodlar zaten eşli; fallback yalnız
  BİLİNMEYEN kodlarda ham kalıyor — kabul edilebilir güvenlik ağı, ayrıca iş açılmadı.

## Faz 2 — Çok-kullanıcılı sertleştirme (ürünleştirmenin bel kemiği)

akisflow.com bugün 2 kullanıcı + kapalı signup ile duruyor. Gerçek kullanıcı almak için:

1. **Kota/limit katmanı:** ~~büyük ölçüde GEMİDEYMİŞ + kalan boşluk kapatıldı.~~
   Ground-truth (2026-07-09): per-user **token kotası** zaten vardı (`usage/quota.ts`,
   tier-aware free/pro, chat + build-start'ta 429 QuotaExceeded) — dokümanlar yine koddan
   geriydi. Gerçek boşluk **eşzamanlılık** idi: bütçesi yeten kullanıcı N paralel build
   açabiliyordu. Eklendi (`37d5f58` + review follow-up `48e7903`): `AKIS_MAX_ACTIVE_RUNS`
   per-user aktif-run kapı — start-only fail-closed pre-check (POST /sessions + approve),
   429 ConcurrencyLimited, FE TR/EN kopyası; anonim muaf (requireAuthForBuilds + anon kota
   yönetir); 0/unset = sınırsız (dev byte-identical). Gate-keeper 0 bulgu; reviewer'ın
   2 MED'i kapatıldı (dürüst kapsam dokümanı + summary-projection sayımı). BİLİNEN kapsam
   sınırı (bilinçli): retry/proceed/confirmPush park statülerinde compute koşturur ve kapıya
   dahil değil — airtight sınır istenirse ayrı ürün kararı.
2. **Rate limiting + abuse yüzeyi:** ✅ KAPANDI (`8393927` + test follow-up `a2b64c5`).
   Ground-truth: auth login/signup/forgot'ta zaten per-IP limiter vardı; boşluk pahalı/yazma
   uçlarıydı. Eklendi: `usage/rateLimit.ts` route-katmanı, opt-in `AKIS_RATE_LIMIT` (default
   kapalı/byte-identical), 3 bucket (build/chat/external-write), owner-yoksa-IP anahtarı,
   429 RateLimited + retry-after + FE TR/EN kopyası. Wired: POST /sessions + approve, chat +
   stream (chatPreflight ile owner tek-çözümleme, quota semantiği byte-korundu), external-write
   propose/confirm. Anonim artık per-IP flood-guard'lı (concurrency muafiyeti kapandı). Auth'a
   always-on reset + change-password limiter'ları eklendi. Gate-keeper 0 bulgu; reviewer 2 bulgu
   → skeptik ikisini de çürüttü (change-pw per-IP mevcut pattern'le tutarlı); chat-preflight
   test kapsamı yine de eklendi. BE 1759/5-skip + FE 762/762.

**Ground-truth (2026-07-09, 5-scout sweep) — kalan Faz 2 kalemlerinin gerçek durumu:**

3. **Gözlemlenebilirlik (PARTIAL):** GEMİDE — OpsBlock (`/health` + authed `/api/ops`:
   uptime/memory/activeSessions/livePreviews/db), `audit_events` durable ledger
   (`GET /sessions/:id/audit`), StatsCollector (`/api/analytics`), RagService.getMetrics +
   UsageCollector sayaçları. GERÇEK boşluklar (temiz-otonom): (a) HTTP error-rate / 4xx-5xx-429
   sayacı (onResponse hook) — S; (b) RagService.getMetrics HTTP'ye açık değil — S. Owner-kararı:
   Prometheus `/metrics` (M — stack'e bağlı), pino yapısal request log (M). CLAUDE.md düzeltmesi:
   `~/.akis/dev-events.json` "error feed" değil tam bus-snapshot + prod'da da yazıyor.
4. **Yedekleme/anahtar (PARTIAL):** GEMİDE — `keys/crypto.ts` AES-256-GCM + scoped AAD (4 secret
   store), `pg.ts` idempotent MIGRATIONS, SELF_HOSTING pg_dump/restore, RAG right-to-forget.
   GERÇEK boşluklar (çoğu OWNER/hukuk kararı): anahtar rotasyonu (M — `keyVersion` yazılıyor ama
   okunmuyor; rotasyon = tüm secret kaybı), hesap silme/GDPR cascade (M), config-volume yedek
   otomasyonu (S), toplu veri export (S), schema-versioning/rollback (L).
5. **Signup/tier (PARTIAL):** GEMİDE — `resolveSignupDisabled` fail-closed, Stripe-webhook tier
   ataması, requireAuthForBuilds, tier-aware quota, users.status/email_verified kolonları (ŞEMADA
   VAR, kullanılmıyor). GERÇEK boşluklar (hepsi OWNER/ürün kararı): davet-kodu/allowlist (M),
   e-posta doğrulama zorlaması (M), self-serve/admin tier yönetimi (M), **insan admin/owner rolü
   HİÇ YOK** (L — abuse hesabı kapatma bile DB elle-edit ister).
6. **Güvenlik (PARTIAL):** GEMİDE — publish SSRF/option-injection field validasyonu, tek XSS-safe
   `<Markdown>`, httpOnly cookie, CSRF Origin-hook. GERÇEK boşluklar (temiz-otonom): (a) CI'da
   bağımlılık taraması YOK (Dependabot + `pnpm audit` — S); (b) chat 502'lerde ham upstream
   provider hata mesajı istemciye sızıyor (`chat.routes.ts:337/445/545` — S, bilgi ifşası); (c)
   CSRF Origin-hook PUBLIC_BASE_URL yoksa/Origin header'sız no-op (S — nüanslı, deploy uyumu).
   NOT: MCP SSRF premisi yanlışmış — REMOTE_MCP_PROVIDERS hardcoded 2 girdi, kullanıcı URL
   veremiyor (bugün SSRF yüzeyi yok).

**Faz 2 sıralaması (öneri):** temiz-otonom kalanlar önce — güvenlik S-üçlüsü (Dependabot+CI audit,
provider-hata temizleme) → observability S-ikilisi (error-rate sayacı, RAG metrics). Sonra OWNER
kararı gerektirenler (admin rolü, invite/allowlist, e-posta doğrulama, hesap silme, anahtar
rotasyonu) ayrı ayrı sunulacak — bunlar ürün/hukuk yüzeyi değiştirdiği için otonom yapılmayacak.

## Faz 3 — RAG/Agents kalanları (**issue #168** — #4'ün doğrulanmış artıkları)

Ground-truth (2026-07-09): repo+upload ingest, `LocalReranker`, semantic embeddings
(OpenAI `text-embedding-3-small` + offline fallback) ve `vector(N)` kalıcılığı GEMİDE.
Gerçek artıklar:
1. **Agent-output ingest kaynağı:** üretilen spec/kod içeriği grounding olarak hiç ingest
   edilmiyor (`IngestionSink.toIngest` yalnız narration `text` map'liyor); typed session
   artifact'lerinden beslenen ayrı bir kaynak eklenecek — read-only, gate-cap'siz, additive.
2. **ANN ranking yolu:** `vector(N)` kalıcı ama sıralama hâlâ JS brute-force cosine (ivfflat
   bilinçli söküldü). Korpus büyüyünce SQL `<=>` + ivfflat/HNSW'ye geçir; JS yolu keyless/pg'siz
   fallback kalır; iki yol arasında golden-eval parity testi.
3. **Scribe-dışı tüketiciler (değerlendirme):** `retrieve_knowledge` bugün Scribe tool-loop'u +
   config'le yetkilendirilmiş advisory ajanlarda; standalone Ask-AKIS chat'i ve Proto/Critic
   tool-loop'u kapsam dışı (Proto SharedContext'ten pasif alıyor). Genişletme değer/risk
   analizi ister — gate'ler değişmez.

## Faz 4 — Ürün yüzeyi / büyüme (owner ile şekillenecek)

- Rafta duran `studio-cohesion-phase1` paketinden değerli kalemlerin seçilerek geri alınması
  (`2026-06-10-cohesion-branch-shelved-tasks.md`; önce oradaki 2 bilinen defekt).
- Onboarding: ilk-kullanım akışı, örnek spec galerisi, "ilk build'ini 2 dakikada al" yolu.
- Landing/positioning: README zaten ürün anlatısında; akisflow.com'a taşınması.
- Fiyatlandırma/BYOK modeli (kendi anahtarını getir varsayılan; shared-key yalnız demo).

## Sıralama önerisi

**Faz 0 kalanı (issue #4 senkronu) → Faz 1 (tarama + küçük PR'lar) → Faz 2 (sertleştirme).**
Faz 2 en büyük ürün riski olduğundan, Faz 1 taraması biter bitmez kota/limit katmanına
başlanması önerilir. Faz 3-4 owner önceliğine göre araya alınabilir.

## Durum günlüğü

- **2026-07-09:** Doküman oluşturuldu; Faz 0'ın oturum-içi kalemleri yapıldı
  (hook opt-in, CLAUDE.md, MEMORY.md, eski plan banner'ı). Branch:
  `claude/session-planning-dcbl56`.
- **2026-07-09 (devam):** Faz 1 ground-truth taraması TAMAMLANDI (5 paralel scout;
  sonuç tablosu yukarıda). Issue #4 kanıtla güncellenip kapatıldı; artıklar #168'de.
  `docs/roadmap.md` agent-output abartısı düzeltildi.
- **2026-07-09 (devam 2):** B5 + B4b + B9 gemiye alındı (`ca57103`, owner merge'i bekliyor,
  branch `claude/session-planning-dcbl56`). Fail-first 5 test; typecheck 3/3 + BE 1728/5-skip +
  FE 751/751 yeşil; gate-keeper PASS (0) + reviewer'ın doğrulanmış tek LOW'u pakette kapatıldı.
- **2026-07-09 (devam 3):** B4a (`ce5ad50`) + B6-i (`eec2c99`) gemiye alındı. Adversarial
  review turu: gate-keeper PASS (0); skeptik panel 1 MED + 1 LOW doğruladı, ikisi de
  `3cc95e4`'te kapatıldı (yanlış MEVCUT şifrede login kopyası regresyonu →
  `settings.password.currentWrong` özel-durumu; JSON'suz edge-403'te Signup "kayıt kapalı"
  status fallback'i geri geldi). FE 756/756 yeşil. Reviewer'ın not düşen (fix'siz) gözlemi:
  `verifiedRuns > done` artık tasarım gereği mümkün — dashboard'da kafa karıştırırsa etiket
  altına küçük açıklama eklenebilir.
  Faz 1'de kalan tek iş: **B6-ii** (error-SSE lokalizasyonu — additive event kodu + FE katmanı).
  Sonrası: Faz 2 (çok-kullanıcılı sertleştirme) veya #168 (RAG artıkları).
- **2026-07-09 (devam 4):** B6-ii gemiye alındı (`9eed9a1`) — **FAZ 1 KAPANDI.** Gate-keeper
  0 bulgu, reviewer temiz (1 pre-existing LOW yukarıda not düşüldü). Süitler: typecheck 3/3,
  BE 1733/5-skip, FE 760/760. Sıradaki karar: **Faz 2 (kota/rate-limit sertleştirmesi)** mi,
  **#168 (RAG artıkları)** mı — owner önceliğine göre.
- **2026-07-09 (devam 5):** FAZ 2 BAŞLADI — kota/limit kalemi kapandı (`37d5f58`+`48e7903`,
  ayrıntı yukarıda Faz 2 §1). Süitler: typecheck 3/3, BE 1746/5-skip, FE 761/761.
  Faz 2'de sıradaki adaylar: §2 rate-limiting genişletmesi (auth'ta zaten var — build/MCP
  uçları ground-truth ister), §3 gözlemlenebilirlik, §5 kademeli signup.
