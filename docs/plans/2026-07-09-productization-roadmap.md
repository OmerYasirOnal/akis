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
2. **PR-c:** B4a — analytics bucketing kararı: "verified-ama-cancelled" ayrı sayaç mı,
   `verifiedRuns`'a mı dahil? (küçük owner kararı ister) + `StatsCollector` testi (bugün hiç yok).
3. **PR-d (en büyük):** B6 — iki sızıntı sınıfına yapısal çözüm: (i) auth sayfaları + genel
   `ApiError` fallback'i için kod→katalog eşlemesi, (ii) `error` SSE olayına `recovery.*` benzeri
   eşleme katmanı. TR/EN parity testleriyle.

## Faz 2 — Çok-kullanıcılı sertleştirme (ürünleştirmenin bel kemiği)

akisflow.com bugün 2 kullanıcı + kapalı signup ile duruyor. Gerçek kullanıcı almak için:

1. **Kota/limit katmanı:** kullanıcı başına eşzamanlı build, günlük build, LLM token bütçesi;
   shared-key modunda özellikle kritik. (Şu an bir kullanıcı sunucunun tüm kaynağını yiyebilir.)
2. **Rate limiting + abuse yüzeyi:** auth uçları, build tetikleme, MCP/external-write önerileri.
3. **Gözlemlenebilirlik:** yapısal log + temel metrikler (aktif build, kuyruk, hata oranı,
   provider gecikmesi); audit ledger zaten var — üstüne operasyonel görünürlük.
4. **Yedekleme/kurtarma:** Postgres yedeği + `encrypted KeyStore` anahtar rotasyon hikâyesi.
5. **Signup'ı kademeli açma:** davet kodu/allowlist → açık kayıt; `AKIS_ALLOW_MOCK` ve
   demo bayraklarının prod'daki duruşunun gözden geçirilmesi.
6. Güvenlik taraması: `pnpm audit` + secret-scan + SSRF/path-traversal yüzeylerinin
   (publisher, MCP) tekrar gözden geçirilmesi. Gate'ler kutsal — değişiklik yok, sadece çevre.

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
  Faz 1'de kalanlar: B4a (owner bucketing kararı bekliyor) + B6 (yapısal i18n, sıradaki büyük iş).
