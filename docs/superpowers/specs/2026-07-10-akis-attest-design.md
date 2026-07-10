# AKIS Attest — Tasarım Dokümanı (Spec)

- **Tarih:** 2026-07-10
- **Durum:** Owner ile birlikte tasarlandı; 4 ana bölüm tek tek onaylandı (yön, ilk kullanıcı, yaklaşım, marka/repo + kanıt modeli, CLI, kanıt sayfası, dogfood). Yazılı spec owner incelemesini bekliyor.
- **Karar sahibi:** Ömer Yasir Önal
- **İlişki:** `akis-platform-mvp` (github.com/OmerYasirOnal/akis) olduğu gibi yaşamaya devam eder; bu spec **yeni bir ürün hattı** başlatır. AKIS'in stratejik "verifiability layer" kararının (2026-06) sonuna kadar götürülmüş hâlidir.

## 1. Bağlam ve motivasyon

Bitirme projesi bitti (v1.0.0 yayınlandı, rapor 93/100 AA). 2026-07-10 ground-truth analizi
(7 ajanlı sweep: ürün yüzeyi, iş defteri, ops, kod sağlığı, değer kritiği, pazar) şu net hükmü verdi:

- **Gerçekten eşsiz olan:** yapısal insan-onay gate'leri + Ed25519-imzalı attestation/passport +
  "gerçekten çalıştır, asla yeşile boyama" doğrulama disiplini + dürüstlük kültürü. Rakip analizi:
  *"nobody ships this."*
- **Değersizleştiren şey:** bu katman, vanilla-JS oyuncak uygulama üreten bir app-builder'a
  (Proto) yapıştırılmış. Builder pazarı 4,7 milyar $ ve konsolide oluyor; solo geliştirici için
  builder'larla yarışmak ölümcül.
- **Pazar boşluğu:** geliştiricilerin %96'sı AI koduna güvenmiyor (adoption %84 vs trust %29);
  "freelancer/ajansın AI-yapımı teslimatını müşteriye KANITLI teslim etmesi" kategorisi **boş**
  (Trustgent = sağlayıcı-düzeyi dizin, ClientProof = doğrulamasız portal).
- **Karar:** kanıt katmanını üreticiden ayrıştır; **başkalarının araçlarıyla (Claude Code, Cursor,
  Lovable…) üretilen gerçek işlere takılan** bağımsız bir teslimat-kanıtı ürünü yap.

### Onaylanan karar zinciri

| Soru | Karar |
| --- | --- |
| Yön | **Kanıt katmanı, üreticiden ayrıştırılır** (app-builder emekli) |
| İlk kullanıcı / başarı | **Dogfood-first:** önce owner + portföy; 3 ayda 2-3 gerçek teslimatın açık kanıt sayfası + ilk dış kullanıcı |
| Yaklaşım | **A: CLI + statik kanıt sayfası** (sıfır sunucu); Sigstore v1.1; hosted portal ancak v2 |
| Marka/Repo | **Yeni repo `OmerYasirOnal/akis-attest`, ürün adı "AKIS Attest"** — AKIS markası taşınır, tez tarihçesi geride kalır |

## 2. Ürün tanımı

> **Tek cümle (EN, ürün dili):** *Ship AI-built work with proof — human-approved gates, really-run
> tests, a signed attestation, one shareable link.*

- **Hedef kullanıcı (v1):** AI araçlarıyla iş üretip teslim eden geliştirici/freelancer — ilk örnek
  owner'ın kendisi. (v2 adayı: ajanslar, "vibe-code cleanup" servisleri.)
- **Çözülen acı:** "Bu işi AI'la yaptın; ne test edildi, kim neyi onayladı, elimdeki şeyin o
  olduğunu nereden bileyim?" sorusuna verilecek kanıtın yokluğu.
- **Değer önerisi:** herhangi bir repoya takılır; projenin **kendi** test süitini gerçekten koşturur;
  insan onaylarını değiştirilemez bir deftere yazar; hepsini imzalı, offline-doğrulanabilir tek bir
  kanıt sayfasında müşteriye sunar.
- **Sunucu bileşeni yok.** Üretilen her şey statik ve taşınabilir.

## 3. Kapsam

### v1 kapsamı
- CLI (`attest`): 6 komut (aşağıda), 3 kapı, hash-zincirli ledger, Ed25519 imza, `proof.html` üretimi.
- Kanıt sayfası: tek dosya, self-verifying, EN+TR, dürüstlük kutusu.
- Dokümantasyon: EN README (ürün dili), hızlı başlangıç, tehdit modeli özeti ("ne kanıtlar / ne kanıtlamaz").

### Bilinçli kapsam dışı (v1)
- **Sigstore/Rekor keyless imza → v1.1.** v1 lokal anahtarla imzalar ve bunu sayfada dürüstçe etiketler.
- **GitHub Action sarmalayıcı → v1.1+** (aynı çekirdeği saran ince YAML yüzeyi).
- **Hosted kanıt portalı (karşı-imza, versiyonlu teslimat listesi, müşteri hesabı) → v2**, ancak A kendini kanıtlarsa.
- **Emekli olan AKIS parçaları:** Proto/Scribe/Critic/Trace ajanları, chat studio, preview altyapısı,
  RAG, MCP connect, hosted multi-tenant backend. Taşınan şey kod değil **disiplin ve formatlar**:
  fail-closed davranış, dürüst etiketleme (DEMO rozeti kültürü), append-only audit ledger fikri,
  passport/attestation şeması, "denetlenemeyen kriter = skipped, asla yeşil" kuralı.

## 4. Mimari

### 4.1 Kanıt modeli
Her hedef repoda `.attest/` dizini:

```
.attest/
  config.json      # test komut(lar)ı, proje adı, anahtar parmak izi
  ledger.jsonl     # hash-zincirli, append-only olay defteri
  attestation.json # export anında üretilen in-toto/SLSA hizalı statement
  attestation.sig  # Ed25519 imzası
```

- **Ledger olayı:** `{ seq, ts, kind, gitSha, dirty, actor, payload, prevHash, hash }`.
  `hash = SHA-256(kanonik-JSON(olay - hash alanı))`; her olay `prevHash` ile öncekine bağlanır.
  Silme/değiştirme zinciri kırar; `attest check` bunu yakalar.
- **3 kapı (v1):**
  1. **`plan`** (insan) — kapsam özeti + git SHA + zaman: "ne yapılacağı" onayı.
  2. **`verify`** (makine) — projenin kendi test komutu gerçekten koşar. Kaydedilen: komut, exit
     code, süre, parse edilebiliyorsa test sayıları (vitest/jest JSON reporter), stdout digest'i,
     ortam parmak izi (node sürümü, OS, lockfile hash), git SHA + dirty bayrağı. **Fail ise fail
     yazılır; başarı asla taklit edilmez.** Opsiyonel boot-smoke probe (config'te komut + beklenen
     HTTP cevabı) AKIS'ten taşınan "çalıştır ve gözle" yaklaşımıdır.
  3. **`delivery`** (insan) — "bunu teslim ediyorum" onayı. **Fail-closed:** HEAD için geçmiş
     bir PASS verify yoksa veya working tree kirliyse reddedilir.
- **Attestation:** in-toto Statement biçiminde: `subject` = **her zaman git SHA**; config'te
  artifact glob'ları tanımlıysa ek olarak o dosyaların SHA-256 digest'leri (v1 default: yalnız git
  SHA — glob'lar opsiyonel). `predicate` = kapı zinciri (ledger kök hash'i dahil), verify sonuçları, ortam.
  Ed25519 (node:crypto) ile imzalanır. Anahtar `~/.config/akis-attest/` altında; kaybı = yeni
  kimlik (dokümante edilir).
- **İmza dürüstlüğü (v1):** kanıt sayfası açıkça söyler — *"Bu imza, defterin bu anahtar sahibi
  tarafından üretildiğini ve sonradan değiştirilmediğini kanıtlar; bağımsız bir üçüncü tarafın
  onayı değildir."* v1.1'de CI + Sigstore keyless (GitHub OIDC + Rekor şeffaflık logu) bu sınırı kaldırır.

### 4.2 CLI
Node 22 + TypeScript; **sıfıra yakın runtime bağımlılık** (node:util `parseArgs`, node:crypto) —
"denetleyebileceğin kanıt aracı" hikâyesinin kendisi güven unsurudur. Dev bağımlılıkları serbest (vitest, tsx).

```
attest init                    # .attest/ + config + anahtar üretimi (yoksa)
attest approve plan -m "..."   # kapı 1
attest verify                  # test komut(lar)ını koşar, sonucu kaydeder
attest approve delivery        # kapı 3 (fail-closed kurallar yukarıda)
attest export [--draft]        # proof.html + bundle üretir
attest check [path]            # offline doğrulama: imza + hash zinciri (şüphecinin aracı)
```

- `export` kapılar tamamlanmadan tam kanıt üretmez; `--draft` görünür filigranlı taslak verir.
- CLI mesajları EN. Binary adı `attest`; npm paket adı adayı `akis-attest` (müsaitlik plan
  aşamasında doğrulanacak — açık soru §8).

### 4.3 Kanıt sayfası (`proof.html`)
- **Tek dosya, tamamen statik, dış istek sıfır.** Attestation JSON gömülü; WebCrypto ile Ed25519
  imzasını **tarayıcıda** doğrular ve sonucu görünür rozetle gösterir.
- İçerik: proje + teslimat sürümü, kapı zaman çizelgesi, test sonuçları (sayılar + süre + ortam
  parmak izi), artifact digest listesi, **"Bu neyi kanıtlar / neyi KANITLAMAZ" dürüstlük kutusu**,
  şüpheciler için tek satırlık `attest check` talimatı.
- **EN+TR** ilk günden (katalog küçük; owner'ın müşterileri iki dilde de olabilir).
- Vercel/GH Pages/herhangi bir statik host'a atılır — müşteriye tek link.

## 5. Hata durumları ve kenarlar

| Durum | Davranış |
| --- | --- |
| Working tree dirty | `verify` kaydeder ve işaretler; `approve delivery` **reddeder** |
| Test komutu fail | Fail olarak deftere yazılır; sayfada dürüstçe görünür; delivery kapısı açılmaz |
| Ledger zinciri kırık (kurcalama) | `attest check` FAIL + hangi seq'te kırıldığı |
| HEAD için verify yok | `approve delivery` reddeder ("run `attest verify` first") |
| Anahtar kaybı | Yeni anahtar = yeni kimlik; eski kanıtlar eski anahtarla doğrulanmaya devam eder |
| Git repo değil | `init` reddeder (git zorunlu — subject git SHA'ya bağlı) |
| Reporter parse edilemiyor | Test sayıları "unparsed" olarak işaretlenir, exit code yine kanıttır (skipped-dürüstlüğü) |

## 6. Test stratejisi

- **TDD** (fail-first). Birim: hash zinciri (kurcalama senaryoları dahil), imza üretim/doğrulama,
  fail-closed kapı kuralları, kanonik JSON kararlılığı.
- Entegrasyon: fixture repo üzerinde tam akış (`init → plan → verify → delivery → export → check`).
- E2E: üretilen `proof.html`'in gerçek tarayıcıda (Playwright) imzayı doğruladığının kanıtı —
  doğrulama satan ürünün kendi E2E'si eksik olamaz (AKIS'in bu dersinden).
- Meta-ilke: bu reponun kendi release'i de `attest` ile kanıtlanır (aşağıda dogfood #2).

## 7. Dogfood planı ve başarı kriterleri

1. **İlk gerçek teslimat:** owner'ın bir portföy/freelance projesine takılır → ilk kamuya açık kanıt
   linki omeryasironal.com'a eklenir.
2. **Meta-showcase:** `akis` reposunun (veya `akis-attest`'in kendi release'inin) kanıt sayfası —
   "kendi ilacını içiyor" hikâyesi.
3. **Yayın:** EN README + hızlı başlangıç ile repo public; duyuru owner kararıyla.

**Başarı (3 ay):** 2-3 gerçek teslimatın kamuya açık kanıt sayfası + ilk dış kullanıcının aracı
kendi reposunda denemesi. Gelir hedefi v1'de yok (dogfood-first kararı); v1.1/v2 kapıları
(Sigstore, hosted karşı-imza) bu öğrenmeyle açılır.

## 8. Açık sorular (plan aşamasında çözülecek)

- npm paket adı müsaitliği (`akis-attest`? scope `@akis/attest`?) ve `attest` binary adının PATH çakışmaları.
- vitest/jest dışındaki test runner'lar için reporter-parse kapsamı (v1'de kaç adapter?).
- Artifact digest kapsamı: v1 default'u yalnız git SHA (§4.1); glob önerileri ve `git archive`
  tabanlı tam-paket digest'i v1.1 adayı olarak değerlendirilecek.
- Kanıt sayfası tasarım dili (AKIS görsel kimliği mi, yeni mi) — implementasyonda `frontend-design` ile.

## 9. Bu repoya etkisi

- `akis-platform-mvp` değişmez; productization roadmap'i (docs/plans/2026-07-09-productization-roadmap.md)
  owner önceliklendirmesine tabidir. Bu spec'in tek dokunuşu bu doküman + session memory güncellemesidir.
- Yeni repo `akis-attest` implementation-plan onayından sonra açılır (brainstorming HARD-GATE:
  onaysız scaffold yok).
