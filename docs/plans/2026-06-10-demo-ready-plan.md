# Main'i TAM DEMO EDİLEBİLİR ürüne taşıma planı (2026-06-10)

> **2026-06-12 — DEMO BETİĞİ HAZIR:** `docs/research/demo-sweep-2026-06-12/demo-plan.html`
> (canlı Playwright taraması main `9c9a3e1`'de uçtan uca PASS; 2 alternatifli 3-4 dk betik +
> prova checklist + risk/kurtarma + öncelikli küçük-iş listesi + 20 ekran kanıtı). YENİ canlı
> bulgu D1-1: push-gate'te "▶ Uygulamayı çalıştır" canlı sayfada çıkmıyor (codeFiles snapshot'ı
> gate olayında tazelenmiyor; F5 workaround) — demo-öncesi en öncelikli küçük fix.

> Hedef (owner): branch'e dönmeden, main üzerine 1-2 çekirdek fonksiyon ekleyerek ürünü uçtan uca
> demo edilebilir yapmak. Kanıt tabanı: canlı tarayıcı turu (temiz kullanıcı `demo-tour@akis.dev`,
> gerçek build `85a8e929`, screenshot'lar `docs/research/tour-2026-06-10/`), `~/.akis/dev-events.json`
> günlüğü ve `docs/research/2026-06-09-github-push-and-preview-state-rootcauses.md`.
> Demo akışı tanımı: kayıt/giriş → sohbetten spec → onay → canlı pipeline → **çalışan uygulamayı GÖR**
> → güven raporu → GitHub'a push → (ops.) kendi sunucusuna yayınla. Bugün bu akış 3 yerde kırılıyor.

## A — Demo-blocker'lar (sırayla; her biri ayrı PR + test + gate-keeper)

### A1. Orchestrator version-conflict yarışı (build sürerken sohbet yazmak build'i öldürüyor)
- Kanıt: dev-events günlüğünde 2 seeded build `Proto OK → "version conflict: 4 !== 3" → RunFailed`.
- Kök: pipeline yazımları runPipeline başında yakalanan BAYAT versiyonla commit ediyor
  (`Orchestrator.ts:368` + :375/:417/:430/:437/:445, retry yok); `chatAppend` (server.ts:568) ise
  her sohbet turunda versiyonu artırıyor ve KENDİSİ retry'lı — asimetri bug'ın kendisi.
- Çözüm: `updateResilient(id, patchFn)` — { get → update(patch, cur.version) } döngüsü, yalnız
  `/version conflict/` yakala, bounded (≤5). Yamalar additive/non-gate. NFR-reliability-7/8 kalıbı.

### A2. GitHub push gerçek yolu (taze kullanıcıda her push ölüyor)
> **DURUM 2026-06-10: HAZIR — owner merge onayı bekliyor.** Worktree `agent-ad3be700dc2d0933a`
> (6 commit, son: `a19eb95`); gate-keeper PASS (0 bulgu) + reviewer SHIP (mustFix boş, MED+2 LOW
> kapatıldı). BE 1586/5-skip + FE 622 yeşil. CANLI doğrulandı (:3001/:5175, push creds'siz boot):
> bağlantısız kullanıcı push → TR banner "Bağlı bir GitHub hedefi yok…" + "Ayarlar'da GitHub bağla"
> CTA + ham İngilizce satır YOK + `push_failed` park; Settings sahip/ad doğrulaması inline + Connect
> disabled. İki keşif: (1) iki-store karmaşası gerçek push yolunda YOKMUŞ (confirmPush zaten yalnız
> delivery store okuyor — doc'un #4'ü Path B'ye özgü); (2) turdaki 404 bağlantısızlık değil,
> env'deki paylaşılan adapter'ın var-olmayan repo'ya işaret etmesiymiş — createRepo bunu çözüyor.
> BİLİNÇLİ VARSAYILAN (reviewer LOW ack): env push creds set ise bağlantısız authenticated kullanıcı
> paylaşılan env hedefine push'lar ve repo yoksa OLUŞTURUR — tek-kullanıcılı dev/self-host için
> doğru; çok-kullanıcılı prod'da env push creds bırakılMAmalı (prod akisflow'da yok).
> Gerçek-GitHub uçtan uca creation testi owner'ın connect'ini bekliyor (owner-gated).

### A2.1. Proje-başına repo + token-only connect (OWNER KARARI 2026-06-11)
- Settings GitHub delivery ekranı **repo SORMAZ** — "Connect GitHub" yalnız authenticate eder
  (bağlantı = token + GitHub login'i; mevcut sahip/ad alanı + FE doğrulaması KALDIRILIR).
- Her proje (yeni chat/build ailesi) kullanıcının **kişisel alanında kendi reposunu** alır: ilk
  push'ta proje adından slug türetilir (TR karakter dönüşümü + çakışmada sonek), `POST /user/repos`
  ile private oluşturulur (A2'nin createRepo+seeding altyapısı aynen kullanılır), push-gate kartı
  hedefi onaydan önce gösterir; seçilen repo session'a additive alanla kaydedilir (retry/değişiklik
  istekleri aynı repoya).
- "Var olan repoyu projeye dahil etme" = AYRI, ertelenmiş bir adım (şimdilik yok — owner).
- Hedef çözümleme önceliği: session.repo → (bağlantı varsa) kişisel alan + türetilmiş ad →
  (bağlantı yoksa) A2'nin dürüst reddi. Env paylaşılan fallback yalnız tek-kullanıcılı dev/self-host.
- Gate-4 disiplini değişmez; akis-gate-keeper + akis-reviewer süreci aynen.
- Tur kanıtı: push → kırmızı ham satır `push failed: github: request to /git/blobs failed (HTTP 404)`
  (İngilizce, TR'siz), Settings'e/connect'e yönlendirme yok; gate satırı "awaiting + Confirm push"ta
  TAKILI kalırken altta hata (çifte durum).
- İşler (priority-0 dokümanındaki yol haritası):
  1. Repo creation / empty-repo seeding (`RealGitHubAdapter.createRepo` şu an no-op) + repo seçici
     (serbest-metin owner/name kutusu yerine; Settings → GitHub delivery).
  2. Yapılandırılmış hata: 404/eksik-repo → kod + kullanıcı-dili mesaj + "GitHub'ı bağla / repo'yu seç"
     CTA'sı; ham transport stringi yalnız log'a.
  3. Mock-fallback dürüstlüğü: bağlantısız kullanıcıda sahte `github.com/mock/...` URL'si asla
     "başarılı push" gibi sunulmasın.
  4. İki-yol/iki-store birleşmesi (delivery connect vs MCP connect → 409 karmaşası).

> **OWNER İLKESİ (2026-06-11, oturum d38d456c):** "Proto çalışan bir kod yazdıysa her halükârda
> preview edebilmeliyiz — Trace ve Critic preview için blocker OLMAMALI." Critic/Trace yalnız
> DOĞRULAMA ve PUSH'u kapılar; görme/çalıştırma kodun varlığına bağlanır. + KABİLİYET DÜRÜSTLÜĞÜ:
> AKIS/Scribe, desteklenen stack'i (tarayıcı HTML/CSS/JS + Node servis; gerçek test + canlı önizleme
> bunlarda) sohbette açıkça söylemeli; Python vb. istenince "üretirim ama doğrulayamam/önizleyemem"
> dürüstlüğü + desteklenen alternatif önerisi (d38d456c: main.py+lib.js karışımı, Trace 0 test,
> önizlenemez çıkmaz sokak — bunu önler).

### A3. Preview correct-state + "uygulamayı GÖR" anı
> **DURUM 2026-06-12: TAMAMI HAZIR — PR #156 owner merge'i bekliyor** (branch
> `fix/preview-staleness-a3-a4`, 7 commit, worktree `.claude/worktrees/a3a4-preview-state`).
> A3.1 zaten #155'te gemideymiş (ground-truth taraması doğruladı: canRun = kod-varlığı +
> PREVIEWABLE_STATUSES, isDone yalnız trust/publish'i kapılıyor). Kalanlar bu PR'da:
> - **A3.2+A3.4 TEK MEKANİZMA:** `projectPreviewLiveness` (`backend/src/preview/replayProjection.ts`)
>   — replay-time projection (GET /log + SSE replay, copy-on-write): registry'nin sırtlayamadığı
>   `ready`/`starting` → `stopped` (url düşer → FE ⏸ + ▶ Run); registry failed/unsupported →
>   o status (+reason); `#verify` girdileri oturum frame'ini etkileyemez. (Plandaki "watchdog"
>   iddiası bayattı: 125s view-keyed watchdog #82/#83'ten beri VARDI; kalan boşluk hayalet
>   replay'di — projection onu kapattı.)
> - **A3.3 PLANDAN DERİN ÇIKTI:** url hep `/preview/:id/` (SABİT) → `key={url}` tek başına no-op;
>   üstelik BE prewarm canlı preview'ı restart etmiyordu → ESKİ byte'lar servis ediliyordu. Çözüm
>   çift katman: prewarm `done`'da `ready` entry'yi RESTART eder (starting'i atlar; slot reuse,
>   çift-done in-flight guard'lı) + FE `preview.epoch` (her ready fold'da artar) → iframe
>   `key=url+reloadNonce+epoch` her taze boot'ta remount.
> - **A3.5:** `foldRunBubbles` post-pass — push_failed recovery awaiting iken çelişkili awaiting
>   "Confirm push" gate satırı düşürülür (sıra-bağımsız; SUNUM-ONLY, backend gate emisyonları
>   byte-identical; TrustLedger wire-state'ten okumaya devam eder).
> - **+ canlı-doğrulama LOW'u:** park (recovery fold) snapshot'ı yeniden okutur → rebuild
>   push_failed'a park edince ▶ Run reload'suz görünür.
> Review: gate-keeper PASS (0 bulgu) + reviewer PASS (1 LOW → kapatıldı). BE 1687/5-skip (+24) +
> FE 694 (+15) + tsc temiz. CANLI doğrulandı (:3001/:5175, TAM HOME izolasyonu — owner stack'ine
> sıfır temas): restart→reopen ⏸+Run; rebuild'de bayat byte YOK (done-restart telde
> ready→done→stopped→ready); kanıt `docs/research/live-2026-06-11-a3a4/` (8 screenshot).
> Demo notu: push-creds'siz ortamda `done` hiç ateşlenmez (önce push_failed parkı) → change-request
> rebuild'i yeni uygulamayı görmek için BİR ▶ Run tıkı ister; bayat byte asla gösterilmez.

> **REVIEW FOLLOW-UP (2026-06-12 gecesi, owner talimatı):** PR #156'nın 15-bulguluk recall
> review'ı işlendi — **11 FIXED** (8 commit, `c1dac41..a704c9d`: per-session start koordinatörü
> + trailing-done katlama + canlılık re-check; park'ta Stop gizleme; iki fold'da ölü-URL temizliği;
> recovery kartında delivery; critic-park snapshot tazeleme; gate-hortlama penceresi; shared
> CANCEL_IMMUNE seti; koşulsuz-cancel helper'ı; resumed-tab /log re-sync), **3.5 DEFERRED → P0-2**
> (registry-içi: digest-skip, non-evicting prewarm, eviction-yarımı — inline cevaplarda gerekçeli).
> Delta üzerinde gate-keeper **PASS (0)** + reviewer **SHIP (MED+ yok)** + CI yeşil; BE 1697 +
> FE 707 + parity. 15 yoruma tek tek cevap + PR özeti yazıldı. **#156 owner merge'ine tamamen hazır.**

### A4. `newChat` park edilmiş run'ı cancel'lamasın
> **DURUM 2026-06-12: HAZIR — aynı PR #156'da.** İki taraflı: BE `CANCEL_IMMUNE = TERMINAL ∪
> {push_failed, verify_failed}` → 409 WrongStatusError (paylaşılan `TERMINAL_STATUSES` const'u
> GENİŞLETİLMEDİ — resilient-writer/release tüketicileri var; `awaiting_push_confirm` cancel'lanabilir
> KALDI — canlı gate abandon davranışı korunarak test edildi). FE: newChat/startBuild/seedRun cancel
> kararını TAZE `getSession`'la verir (fire-and-forget; fetch hatasında cancel atlanır — BE guard ağ).
> Canlı doğrulandı: "New build" sonrası park `push_failed` kaldı, FE SIFIR cancel çağrısı attı;
> açık cancel probe'u 409 + state korunmuş.
- Tur kanıtı: push_failed (park, yeniden denenebilir) oturum, Stüdyo tıklanınca `cancelled`a düştü —
  FE'deki backendStatus push_failed'a hiç güncellenmemişti (A3'le aynı staleness ailesi).
- Çözüm: cancel kararından önce taze status oku (veya backend cancel'ı terminal-park'ta 409'lasın).

## B — Demo cilası (A'dan sonra, çoğu raf branch'inde hazır fikir)
- B1. Build başlayınca görünüm spec'te kalıyor; sticky "derleniyor" barı yok (H3+H5 — raf: 30cf299).
- B2. Scribe chat-seeded build'de "idle" görünüyor (raf: 9d631bb).
- B3. Çift "Live preview" başlığı + drawer header sadeleşmesi (raf: dddec9b/0e94bbe).
- B4. Analytics: cancelled-ama-verified tutarsız sayımlar + ham markdown başlık satırı
  (`feat/analytics-usage-report` branch'inde "clean titles" zaten var — değerlendir).
- B5. Provider keys "Connected" etiketi shared-key'de yanıltıcı (`keySource:'shared'` → "Sunucu
  anahtarı" gibi dürüst kopya).
- B6. TR oturumda İngilizce hata/durum satırları (push hatası, drawer kopyaları) — i18n süpürmesi.

- B7. **"Yeni sohbete geçiş" UX'i (owner feedback 2026-06-10, sonraya not):** Stüdyo-nav'ın yeni sohbet
  açması GERİ ALINDI (aktif sohbeti uçuruyordu — anlaşılır değil; revert `9612abc`). Asıl sorun: "Yeni
  geliştirme" yeterince görünür değildi / sıfırdan başlanacak bir ana ekran yok. Şimdilik yapılan: buton
  belirginleştirildi (teal primary, `d41bc88`). Öncelikli işler bitince seçenekler: (i) Stüdyo'ya tıklayınca
  aktif sohbet KORUNUR + belirgin "Yeni geliştirme" (bugünkü hal — en basit); (ii) aktif sohbet varken
  Stüdyo'da hafif bir karşılama/ana-ekran: "devam eden sohbet" kartı + "Yeni geliştirme" CTA'sı; (iii) New
  build'e tek-tık onay ("aktif sohbet History'den geri açılabilir" notuyla). Öneri: önce (i) ile yaşa,
  gerekirse (ii)'yi tasarla.

- B9. **AgentWriteProposals poll'u koşulsuz (gözlem 2026-06-12, pre-existing):** aktif oturum açıkken
  `listExternalWrites` sabit aralıkla sürekli poll'lanıyor (10 dk'lık sayfada yüzlerce GET; hepsi 200,
  zararsız ama gürültü). MCP yazması beklenmeyen oturumda poll'u durdurmak / SSE event'ine bağlamak
  ucuz bir cila. (PR #156 tarayıcı doğrulaması sırasında network log'unda fark edildi.)

- B8. **Build-öncesi sohbetin URL kimliği yok (owner bulgusu 2026-06-11, BY-DESIGN ama not):** spec
  onaylanana kadar session yaratılmadığı için adres çubuğunda `?s=` görünmez; onayla birlikte gelir.
  Chat-first tasarımın doğal sonucu — sohbet sunucuda ancak build ile var oluyor. İleride istenirse:
  ilk mesajda bir "konuşma kimliği" mint edip URL'e koymak (konuşma permalink'i) = ayrı bir özellik
  (taslak sohbetlerin sunucuda kalıcılaşması dahil). Şimdilik kapsam dışı.

## C — Owner-gated / ortam
- C1. akisflow.com canlı (HTTPS, güncel main); signup toggle'ı tamamlandı — tekrar KAPALI, 2 kullanıcı.
- C2. Push demosu için owner GitHub connect (callback kayıtları) + gerçek repo.
- C3. 68+ commit'lik local main'in origin'e push'u (CI billing-bloklu — tek güvence yerel gate).
- C4. Google OAuth URI'ları, Atlassian MCP canlı e2e (demo kapsamı dışı tutulabilir).

## Bugün yapılanlar (bu plana zemin) — owner feedback'i işlendi
- main'e: `be804a4` resize çizgisi dikişe (owner: "olmuş") · `717d635` Stüdyo=yeni-sohbet → owner geri
  istedi → revert `9612abc` (kalıcı çözüm B7'de) · `d41bc88` = run yokken full-width void-gate (owner:
  "çözülmüş") + Recent etiketi "Son projeler / Recent projects" (owner'ın basit-çözüm tercihi; recents'i
  temizleme yaklaşımı İPTAL) + belirgin "Yeni geliştirme" butonu. FE 615 yeşil + tsc temiz.
- A1 (orchestrator updateResilient) ayrı worktree'de ajanla BAŞLATILDI (owner onayı 2026-06-10);
  dönünce gate-keeper + reviewer'dan geçirilip ayrı portta canlı doğrulanacak.
- Raf notu: `docs/plans/2026-06-10-cohesion-branch-shelved-tasks.md`.

## 2026-06-11 gece — drawer cilası HAZIR + yeni bulgu audit'i
- **B3 + 2 yeni owner bulgusu (resize boşluğu, köşe radius) FIXED:** branch
  `fix/preview-drawer-polish-2026-06-11` (HEAD `52d42e2`, taban `a384b12`), worktree
  `.claude/worktrees/agent-a697e600988579bef`. gate-keeper **PASS** (0 bulgu) + reviewer **SHIP**
  (mustFix boş); FE 682 + `pnpm -r typecheck` + TR/EN parity yeşil; before/after kanıtı
  `docs/research/preview-drawer-polish-2026-06-11/`. **Owner merge bekliyor** (push/PR yok).
  MERGE NOTU: `fix/preview-staleness-a3-a4` (PR #156) ile TEK dosyada bilinen mekanik çakışma —
  `PreviewPanel.test.tsx` (iki branch da aynı anchor'dan sonra test bloğu ekliyor; ikisini de
  tut + import'ları birleştir). Kaynak dosyalar (`PreviewPanel.tsx`, `PreviewDrawer.tsx`)
  temiz auto-merge olur.
  **ROUND-2 (owner geri bildirimi, 2026-06-12 gecesi): HEAD artık `e853670`.** (1) Sol dikiş
  boşluğu 25px→13px (`pl-6`→`pl-3`; separator'ın görünür izi 1px hairline, 12px'i görünmez
  tutma alanı — sağ/altla simetrik); (2) ready-state köşe: iframe ayrı paint katmanı olarak
  `overflow-auto` sınırından ata kırpmasını deliyordu → DeviceFrame letterbox'a
  `rounded-b-[11px]` (band 12px − 1px border); Brave+izole profille iframe'li halde ölçüldü.
  Delta GK PASS (0) + reviewer SHIP (1 LOW watch: 11px literal'i PreviewPanel'deki rounded-xl
  türevi, dosyalar-arası sabit yok — yorumla belgelendi). Round-2 delta'sının #156 ile dosya
  kesişimi SIFIR; branch-genel tek çakışma yukarıdaki test-append. FE 73/684 + tsc temiz.
  **ROUND-3 (owner bulgusu, 2026-06-12 gecesi): HEAD artık `9f7b61c` (PR #157'ye push'lu).**
  Drawer'ın DIŞ sağ köşeleri kareydi ve sohbet kartının `rounded-2xl` kavisini kesiyordu —
  **main'de önceden beri var** (A/B: 5173 #157'siz ↔ 5176 birleşik piksel-aynı; yani #157
  regresyonu DEĞİL, iç köşeler cilalanınca göze battı). Fix: aside'a `rounded-r-2xl`
  (sol kenar/dikiş kare kaldı) + pin testi. Canlı Brave ölçümü: radius `0 16px 16px 0`,
  TR/BR köşe pikselleri kavisin dışında (`corner-merged-5176-round3.png`). Odaklı reviewer
  SHIP (mustFix boş; ✕ butonu geometrisi güvenli — kavis `pr-3` oluğunda kalıyor; 1 LOW not:
  className pin'i görsel kanıt yerine geçmez — canlı screenshot'la kapatıldı). CI yeşil.
- **ENTEGRASYON PROVASI (owner isteği, 2026-06-12): #156 + #157 birleşik — PASS.** Atılabilir
  worktree `integration/156-157-rehearsal` (`58776b9`; round-3 merge sonrası `f3765de` — canlı
  :3002/:5176 stack'i bunu koşuyor): #156 çakışmasız + #157 tek beklenen
  çakışma (`PreviewPanel.test.tsx` append, keep-both çözümü = ileriki rebase'in birebir çözümü).
  Birleşik ağaçta 3×typecheck + BE 1687/5-skip + **FE 73/699** yeşil. CANLI (Brave+izole profil,
  :3002/:5176, build `fcecc30f` + edit-rebuild `f9966a7f`): tek başlık (5 state'te de 1),
  dikiş 12.00/12.00px (delta 0), canlı iframe'de 4 köşe kırpık, reopen DÜRÜST (canlı yeniden
  çalıştırma; ⏸/Run değil stale-ready YOK), **edit-rebuild'de epoch remount + yeni uygulama
  repaint + köşeler hâlâ kırpık** (iki PR'ın tam kesişim yüzeyi). Konsol temiz (1 zararsız
  bayat-profil isteği). Kanıt: `docs/research/integration-156-157-2026-06-12/` (16 screenshot +
  driver.log). Yan gözlemler: verify-fail "0 test" birleşikte de aynı (P0-3, main'de de var —
  entegrasyon regresyonu DEĞİL); Haiku edit'i istenen H1 değişikliğini uygulamadı (model
  içerik-sadakati — demo build'lerinde daha güçlü model düşünülebilir).
- **Yeni demo-blocker audit'i (bilinen liste DIŞI):** `docs/research/2026-06-11-demo-blocker-audit.md`
  — 31-ajanlı adversarial workflow + canlı tur; 15 doğrulanmış yeni bulgu. **P0 önerisi:**
  (1) `confirmPush` terminal yazımları → `updateResilient` (Orchestrator.ts:748/766/780 — A1'in
  atlanan kardeşi, push finalinde 500/asılı-oturum); (2) `PreviewRegistry.start()` re-entrancy
  kilidi (PreviewRegistry.ts:182 — preview klobber + öksüz süreç); (3) **verify-fail dürüstlüğü**
  (CANLI yakalandı, oturum `b8c0b5f9`: e2e 11 koştu/1 gerçek fail "missing literal: Sil" ama
  `TraceAgent.ts:64` token-yoksa testsRun:0 + `Orchestrator.ts:609` statik "no real passing test"
  → owner 5 kör Retry sonrası iptal; kanıt DB'de duruyor, sadece yüzeye taşınmıyor — ayrıntı
  audit dokümanında). Üçü de backend-ağırlıklı, A3/A4 FE işiyle çakışmaz. Owner onayı bekliyor.
