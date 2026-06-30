# Ajan Tespitleri — Çözüm Yolları ve Efor Çalışması (2026-06-12)

Owner'ın 6 tespiti için salt-okunur araştırma. Yöntem: tespit başına bir araştırmacı ajan
+ her raporu kodla çürütmeye çalışan adversarial doğrulayıcı + 2 taze-göz taraması
+ bütünlük kritiği (15 ajan). Her iddia `file:line` kanıtına bağlandı; efor tahminleri
doğrulayıcıların DÜZELTİLMİŞ değerleridir. Hiçbir kod değiştirilmedi.

Efor ölçeği: **S** < 2 saat · **M** ~yarım gün · **L** 1-2 gün · **XL** > 2 gün.

---

## 1) Scribe spec'leri hep İngilizce mi yazıyor?

**Cevap: Bilinçli ama kısmî bir tercih.** Spec gövdesi zaten kullanıcının dilini izleyebilir
("Reply in the user's language", `ScribeAgent.ts:75`); İngilizce'ye sabitlenen şey yalnızca
acceptance-criteria'ların **Given/When/Then iskeletidir** (`ScribeAgent.ts:70,77`). Sebep:
doğrulama hattı (`featureGen.parseScenarios` → `deriveChecks`) yalnız İngilizce Gherkin
keyword'ü tanır (`featureGen.ts:27-52`); TR keyword 0 senaryoya düşer → probe türetimi
smoke-floor'a iner (build kırılmaz ama doğrulama **kapsamı** çöker, `bootSmoke.ts:302`).
Ayrıca UI locale'i backend'e hiç taşınmıyor (`client.ts:337,362`) — dil tamamen LLM sezgisinde.

| Seçenek | Yaklaşım | Efor | Risk |
|---|---|---|---|
| **A — Locale-aware Scribe prompt (ÖNERİLEN)** | UI locale FE→BE taşınır (`useI18n().locale` → chat gövdesi → `expandSpecRequest` → `draftSpec`); prompt "düzyazı kullanıcının dilinde, yalnız G/W/T keyword EN" der. Parser/cucumber'a dokunulmaz. | **M (üst sınır)** — `scribe-draftspec.test.ts:42-46` prompt'u `toBe` ile pinliyor; locale-yok dalı bit-aynı korunmalı + yeni case | Düşük; gate-safe |
| B — Çift dilli spec (EN kanonik + TR görünüm) | `SpecArtifact`'a additive `bodyLocalized`; verify daima EN gövdeyi kullanır | L | Orta — TR görünüm EN kanonikten ayrışırsa onay-bütünlüğü/provenance riski |
| C — Çok dilli Gherkin parser | parseScenarios + criteria + realRun TR keyword öğrenir | L-XL | Yüksek — verify kalbine dokunur, kapsam sessizce düşebilir |

- **Quick win (S):** Locale taşımadan sadece `ScribeAgent.ts:70,77` prompt'unu güncelle
  ("düzyazı kullanıcının dilinde, keyword EN") + Critic `spec-review.ts:47`'ye not
  (TR spec haksız "untestable" bulgusu almasın).
- Doğrulayıcı düzeltmeleri: `scribe.base.md` **ölü dosya** — hiçbir `prompts/*.base.md`
  runtime'da okunmuyor; tüm canlı prompt'lar in-code TS const (`SCRIBE_SYSTEM` vb.,
  `services.ts:410 composeFor('scribe', SCRIBE_SYSTEM)`). Tek prompt hedefi `ScribeAgent.ts`.
  Locale yalnız chat-time `draftSpec`'e gerekli; `run()/compose()` spec'i yeniden draft etmez
  (P1 atomik seed) — onlara dokunulmaz.

## 2) Given/When/Then daha standart/uzmanca olabilir mi?

**Kritik bulgu: Gherkin şu an hiçbir gerçek test motorunu beslemiyor.** Cucumber yolu
(`realRun.ts`) production wiring'de **ulaşılmaz ölü kod**: DI `realTests && verifyBoot` ile
daima boot-smoke'u seçer (`services.ts:288`), `backend/package.json`'da cucumber/playwright
bağımlılığı bile yok. G/W/T'nin tek canlı işlevi `parseScenarios`'un İngilizce `Given` ile
senaryo bölmesi + `deriveChecks`'in (criteria.ts:90-112) regex sinyal çıkarımı. UI'da ise
SpecCard düz `<Markdown>` basıyor (`SpecCard.tsx:78`) — keyword highlight yok. Yani owner'ın
şikâyeti haklı: jargon, kullanıcıya doğrulama değeri katmadan görünüyor.

| Seçenek | Yaklaşım | Efor | Risk |
|---|---|---|---|
| **Çift katman (ÖNERİLEN)** | Makine katmanı G/W/T aynen kalır (verify %100 sağlam); insan katmanı UI'da "Doğrula ki…" / EARS-"SHALL" dilinde okunur checklist olarak render edilir | **M** | Düşük — parser/verify hiç değişmez. İnsan-özeti deterministik türet (serbest LLM metni değil), anlam kayması provenance'a aykırı |
| Gherkin koru + TR keyword (`# language: tr`) | UI render + parser bilingual genişletme | L (üst) — featureGen + criteria + bootSmoke.ts:299 + 8-9 test dosyası | Orta — probe türetimi sessizce zayıflayabilir |
| EARS'a tam geçiş | deriveChecks/parseScenarios EARS'a göre yeniden yazılır | **XL** | Yüksek — "imkânsız literal probe" bug sınıfı geri dönebilir. **YAPMA** |

- **Quick win (S, 1-2 saat):** Yalnız `SpecCard.tsx` render rötuşu — G/W/T keyword'lerini
  rozet/kalın yap, her senaryoyu numaralı kart göster. Saf görsel tut (yeniden-cümle kurma);
  FE'de ikinci bir parser kopyası drift riski yaratır.
- i18n notu: gerçek yapı tek dosya `catalog.ts` (EN + TR blokları), ayrı tr/en dosyası değil.

## 3) Trace "uzman test ajanı" gibi davranabilir mi?

**Kök neden: Trace bir LLM ajanı DEĞİL** — `TraceAgent.run()` sadece `verifier.verify()`
çağırır ("Trace runs the verifier, NOT an LLM", `TraceAgent.ts:46`). Kullanıcının gördüğü
"test case'ler" mekanik üretimdir: senaryo adı = ham kriter metninin ilk 60 karakteri
(`criteria.ts:42`), başarısızlık sebebi = teknik etiket ("status 404", "missing literal"),
sabit isimler ("app boots and serves /", `bootSmoke.ts:302`). `trace.base.md` persona'sı ve
`appliesToRole:trace` test-skill'leri hiçbir kod yoluna bağlı değil (ölü). Proto'nun emit
ettiği unit testler de Trace tarafından **hiç koşturulmuyor** — iki ayrı dünya. Bu kasıtlı
bir invaryant: gate truth LLM yargısına değil, mekanik gözleme dayanır (`criteria.ts:8-16`).

| Seçenek | Yaklaşım | Efor | Risk |
|---|---|---|---|
| **A — Sunum/etiketleme katmanı (ÖNERİLEN)** | Her Check kind'ı için insan-okur "beklenen sonuç" şablonu; `ScenarioEvidence`'a additive `expected/priority`; teknik reason'ları i18n'li metne map'le; TrustReport ISTQB-tarzı satır (ID · başlık · beklenen · durum · sebep) | **M(üst)/L** — 7 dosya; `trust.*` için otomatik parite testi yok, elle TR/EN senkron | Düşük — mint byte-identik. **Yeni alanlar `digestEvidence`'a GİRMEMELİ** (`digest.ts:78-80` yalnız name/suite/passed/reason/step okur) yoksa passport bozulur |
| B — LLM test-planlayıcı persona (faz 2) | Yeni TS const persona (md'yi "bağlamak" değil) + structured-output ISTQB listesi; pass/fail YİNE mekanik probe'tan | L/XL | Orta-yüksek — LLM çıktısı gate'e/digest'e sızmamalı; ancak A oturduktan sonra |
| C — Proto'nun unit testlerini gerçekten koştur | realRun'a `node --test` fazı, TAP parse → ScenarioEvidence | L | Orta — yalnız real-runner yolunu iyileştirir, demo-default'u (boot-smoke) değil |

- **Quick win (S):** Saf-frontend çevirici — `TrustReport.tsx` + `catalog.ts`'te
  "status 404" → "Rota bulunamadı (404)", "app boots and serves /" → "Uygulama açılıyor
  ve / sayfasını sunuyor". Shared/digest'e hiç dokunmaz.

## 4) Analytics ekranı en hızlı nasıl düzelir?

**Sürpriz: Ekran stub değil — tamamen bağlı ve gerçek veriyle çalışıyor** (route, lazy-load,
`GET /api/analytics` ← StatsCollector event-bus tap'i, TR/EN parite tam). "Yarım" algısının
gerçek nedenleri: (a) az çalışmada seyrek görünüm; (b) **dürüstlük çelişkisi** — üst kartlar
TÜM hesaplar arasında global ama copy "tüm geliştirmelerin/all YOUR builds" diyor
(`catalog.ts:289,1095`); (c) sayaçlar in-memory, her restart'ta sıfırlanıyor
(`StatsCollector.ts:23-32`); (d) eski run'larda token "—" (ring-buffer evict).

| Seçenek | Efor | Not |
|---|---|---|
| Menüden gizle (`App.tsx:148` NavLink + `:111` route) | S (<30 dk) | Landing hâlâ "Built-in analytics" vaat ediyor (`catalog.ts:728`) — çelişki doğar |
| **Sadece-copy dürüstlük düzeltmesi (ÖNERİLEN)** | **S (<15 dk)** | `catalog.ts:289+1095` "senin" → "bu örnekteki tüm çalışmaların"; hiçbir test kırılmaz (parite testi yalnız anahtar-kümesi karşılaştırır) |
| ownerId-scope gerçek filtreleme | M (üst) | StatsCollector'da ownerId yok; BE testi sıfırdan yazılır (StatsCollector/analytics.routes testi mevcut değil); `snapshot()` `ops.routes.ts:35,59`'da da kullanılıyor — opsiyonel-param yap, ops global kalsın |
| Tam dashboard (kalıcılık + trend + grafik) | L-XL | Demo için aşırı kapsam |

Demo tek/2 kullanıcılı (signup prod'da kapalı) olduğundan global-vs-owner farkı pratikte
görünmez; copy düzeltmesi + demoda canlı bir build koşturmak ekranı kendiliğinden doldurur.

## 5) Login akışı doğru mu? Signup'a confirm-password gerekli mi?

**Login: EVET, doğru çalışıyor — gerçek bug yok** (kod kanıtıyla; canlı browser doğrulaması
yapılmadı). Olgun güvenlik: timing-safe login (bilinmeyen email'de dummy-hash'e karşı tek
scrypt compare, `auth.routes.ts:110-113`), enumeration koruması, rate limit (10/5dk),
fail-closed signup (`server.ts:762-763`), OAuth'ta verified-email zorunluluğu + var olan
hesaba güvenli link (`UserStore.ts:87-131`, `oauth.ts:152-164`).

**Signup: confirm-password gerçekten yok** (`Signup.tsx:44` tek PasswordInput) — bug değil,
UX güvence eksiği. Parolalı hesapta e-posta doğrulaması da olmadığından tipolu parola
sessizce kaydedilir; alan eklenmesi standart beklenti.

**Öneri (S, <2 saat):** `Signup.tsx`'e ikinci PasswordInput + mismatch kontrolü + buton
koşulu; `catalog.ts`'e `auth.pwMismatch` + `auth.passwordConfirm` (EN **ve** TR — genel
`auth.*` parite testi YOK, tek-locale eklemek sessizce EN-in-TR ship eder) + net-yeni Signup
testi (auth.test.tsx'te Signup testi hiç yok). Üstüne S maliyetle bir `auth.*` parite testi
eklemek (mevcut katalog 37/37 dengeli, anında yeşil geçer) gelecekteki eklemeleri korur.
Parola gücü göstergesi: M, düşük öncelik (signup prod'da zaten kapalı).

## 6) Push öncesi önerilen-ama-editlenebilir repo adı mümkün mü?

**Mümkün ve altyapı hazır.** A2.1 repo adını bilinçli tam-otomatik yaptı:
`deriveRepoName(title, idea)` slug üretir, `resolveAvailableRepoName` çakışma probe'u yapar
(`base`, `base-2`…), sonuç `delivery` **non-gate additive kolonu** olarak pin'lenir ve FE
kartında salt-gösterilir (`ChatThread.tsx:131-135, 178-182`). Eksik olan yalnız (1) düzenleme
UI'ı + route, (2) server-side yeniden doğrulama — gereken saf fonksiyonların hepsi mevcut
(`slugifyRepoName`, `NAME_RE`, `resolveAvailableRepoName`).

| Seçenek | Yaklaşım | Efor | Not |
|---|---|---|---|
| **B — Ayrı `PATCH /sessions/:id/delivery` (ÖNERİLEN)** | Confirm ÖNCESİ "Düzenle → Kaydet" akışı; backend slugify+NAME_RE+çakışma-probe ile yeni delivery pin'ler, `emitGate(push_confirm,'awaiting')` kartı anında günceller; **confirmPush hiç değişmez** (pin'li delivery zaten reuse ediliyor, `Orchestrator.ts:709-710`) | **M** | FE güncelleme mekanizması hazır (`chatModel.ts:97` awaiting'de delivery overwrite) |
| A — `/confirm` body'sine `repoName?` | Tek adım UX ama ÇİFT callback (`onConfirm` + `onConfirmRecovery` closure'ı) ve İKİ kart (GateBubble + RecoveryBubble) imza genişlemesi | M-üst/L | Yalnız tek-adım UX kritikse |
| C — Settings'te hesap-genel ad şablonu | Prefix alanı | S | Owner'ın asıl isteğini (proje-bazlı düzenleme) karşılamıyor |

- **Gate güvenliği:** owner DAİMA server-side token login'inden (`services.ts:506-510`);
  client yalnız ad ÖNERİR; Gate-4 mint'i (`mintApprovedPush`) değişmez. Verify pipeline repo
  adına hiç dokunmuyor (grep: bootSmoke/criteria'da sıfır eşleşme) — coupling yok.
- **Zorunlu güvenlik notu:** `requestedName` ASLA `parseOwnerRepo`'ya birleşik owner/repo
  string'i olarak verilmemeli (client `/` ile owner enjekte edebilir). Doğru zincir:
  `slugifyRepoName(requestedName)` → boşsa 400 → `NAME_RE.test()` → `resolveAvailableRepoName`.
- **Quick win (S):** Mevcut karta "Bu ada otomatik oluşturulacak; çakışırsa -2 eklenir"
  açıklaması (i18n anahtarları zaten mevcut).

---

## Ek tespitler (taze-göz taramaları)

### UX / demo cilası
- **[HIGH] Docs sayfasındaki "GitHub'da düzenle" linki ÖLÜ** — hardcoded
  `github.com/OmerYasirOnal/akis-platform-mvp`, gerçek repo `…/akis` (rename sonrası 404).
  `DocsPage.tsx:148`. Fix: S, tek satır (+ REPO_URL sabiti).
- **[MED] Settings→Agents / Workflow Builder / Preview'da ham rol slug'ları** ("scribe",
  "proto" küçük harf) — `agentName()` helper'ı (names.ts) zaten var, 3 yerde çağrılmamış.
  Fix: S.
- **[MED] "orchestrator" için düzenlenebilir model satırı** — AKIS'in kendisine model
  seçtirmek kafa karıştırıcı; filtrele veya ayrı bilgilendirme satırı yap. Fix: M (önce
  orchestrator-model kaydının pipeline'da gerçekten kullanılıp kullanılmadığını doğrula).
- **[LOW]** Landing "Nasıl çalışır" lead'i gates metnini reuse ediyor (`Landing.tsx:151-153`);
  OAuth kullanıcısına asla çalışmayacak "Şifre değiştir" formu görünüyor
  (`AccountSettings.tsx:61-73`); Settings'te çift logout (`SettingsPage.tsx:48`). Hepsi S.

### Ajan çıktı kalitesi (dil tutarlılığı)
- **[HIGH] README hep İngilizce** — `DOCS_SYSTEM`'de (`ScribeAgent.ts:17`) dil talimatı yok;
  TR spec'li uygulamaya EN README push'lanıyor ve CodeBrowser'da varsayılan açılıyor. Fix: S
  (tek prompt satırı).
- **[HIGH] Trust Report reason/name etiketleri sabit EN** ("status 404", "boot smoke",
  "missing literal") ve i18n'siz render (`TrustReport.tsx:127,163-176`). Fix: M — tespit
  #3'ün çözümüyle AYNI dosyalar; tek pakette yapılmalı.
- **[MED] Bağlı-repo oturumunda ham tool slug'ları** ("github_get_file_contents") canlı
  aktivitede görünüyor — `TOOL_LABEL` haritası (`ChatThread.tsx:9-15`) yalnız 5 aracı
  çeviriyor. Fix: S (prefix-bazlı eşleme).
- **[MED] Orchestrator narrate katmanı sabit EN ve FE'de tamamen bastırılıyor** — iterate /
  README / not-verified-retry geçişleri kullanıcıya hiç açıklanmıyor. Fix: L (yapılandırılmış
  narration kodu + FE t() render) — backlog.
- **[MED] Fallback "Spec for:" öneki** (`ScribeAgent.ts:238,369`) — `SCRIBE_SYSTEM`'in kendi
  "NEVER prefix with 'Spec for:'" kuralını (`:67`) ihlal ediyor. Fix: S.
- **[LOW] PROTO_SYSTEM'de üretilen-app UI dili talimatı yok** + SCRIBE honesty-notu örneği
  sabit Türkçe. Fix: S (iki prompt satırı).

---

## Önerilen paketleme ve sıra (bütünlük kritiği)

Araştırmacı-doğrulayıcı çelişkilerinin hepsinde doğrulayıcı haklı çıktı (kritik tarafından
kodla teyit); yukarıdaki eforlar düzeltilmiş değerlerdir.

| Sıra | Paket | İçerik | Efor |
|---|---|---|---|
| **P0** | Demo cilası (tek oturum) | Ölü Docs linki, agentName() ×3, orchestrator satırı, OAuth şifre-formu, çift logout, landing lead — hepsi salt-FE | 6×S |
| **P1** | Dil tutarlılığı + auth | confirm-password (#5) + README dil talimatı + "Spec for:" fix + github_ tool label + Proto/Scribe prompt dil notları | toplam ~M |
| **P2** | Trust Report okunabilirlik | #3 Seçenek A + Trust Report EN-etiketleri (aynı dosyalar, BİRLEŞİK) + #2 quick-win (SpecCard G/W/T render) | M-L |
| **P3** | Spec dili | #1 Seçenek A (locale FE→BE + Scribe prompt) — P2'den sonra (ikisi de Scribe prompt'una dokunur) | M(üst) |
| **P4** | Analytics dürüstlük | Sadece-copy (<15 dk); istenirse ownerId-scope (M) | S→M |
| **Ayrı** | Repo adı düzenleme | #6 Seçenek B (PATCH /delivery) | M |
| **Backlog** | narrate localize (L), Trace LLM-persona (L/XL), Proto-unit-test koşturma (L), bilingual Gherkin (L), EARS (XL — **yapma**) | | |

**Kesişen disiplinler:** (1) P2'de yeni evidence alanları `digestEvidence`'a girmemeli
(passport bozulur); en güvenlisi presenter'ı saf-FE tutmak. (2) Her pakette `catalog.ts`
EN+TR ikiz blok güncellemesi — global parite testi yalnız anahtar-kümesini denetler, değer
eşitliğini denetlemez. (3) P1 sonrası login+signup **canlı browser doğrulaması** yapılmalı
(bu çalışmadaki auth kanıtı kod-only). (4) Tüm öneriler gate-safe doğrulandı: 4 yapısal
gate, `externalWriteGate.ts`, token sınırı ve store gate-kolonları hiçbir seçenekte
zayıflamıyor.
