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
- [ ] **Issue #4 senkronu:** milestone kutuları gerçek durumla güncellensin — README'ye göre
      Agents/Workflows sekmesi (M3–M5), semantic embeddings (OpenAI `text-embedding-3-small`)
      ve pgvector kalıcılığı gemide. Kalan gerçek boşluklar ayrı, küçük issue'lara bölünsün;
      #4 kapatılabilir.
- [ ] `HANDOFF.md` zaten "historical" işaretli — dokunma. `docs/plans/` altındaki diğer
      demo-dönemi dokümanlarına dokunma (tarihsel kayıt).

## Faz 1 — Ground-truth taraması + küçük ürün pürüzleri

Amaç: eski backlog'un hâlâ geçerli kalemlerini koddan doğrulayıp hızlı kapatmak.
Tek oturumluk bir tarama + ardından küçük PR'lar.

1. **Tarama:** aşağıdaki eski kalemlerin her biri için "gemide mi / hâlâ açık mı" kararı,
   `file:line` kanıtıyla (akis-scout + canlı smoke):
   - B1 sticky "derleniyor" barı · B2 Scribe idle görünümü · B4 analytics tutarsız sayımlar
   - B5 shared-key "Connected" dürüstlüğü · B6 TR i18n süpürmesi (İngilizce kalıntılar)
   - B7 "yeni sohbete geçiş" UX'i · B9 `AgentWriteProposals` koşulsuz poll'u
   - P0-2 registry ertelenenleri: digest-skip, non-evicting prewarm, eviction-yarımı
     (gerekçeler PR #156 inline cevaplarında)
2. **Hâlâ açık çıkanları** öncelik sırasına koyup 1-2 kalemlik PR'lar hâlinde kapat.
   (Ürün gözüyle en değerlileri: B5/B6 dürüstlük+dil tutarlılığı, B9 gereksiz yük.)

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

## Faz 3 — RAG/Agents kalanları (issue #4'ün gerçek artıkları)

Koddan doğrulanacak; bugünkü bilinen adaylar:
1. **Ingest kaynakları (M2 artığı):** agent çıktıları + repo + upload'ların
   `IngestionSink.toIngest`'e tam bağlanması (MEMORY.md'ye göre yalnız `text` map'liydi —
   doğrula).
2. **Rerank bütçesi** (p95 < 300ms hedefiyle) ve retrieval kalite ölçümü (golden-eval seti
   genişletme).
3. **Scribe-dışı tüketiciler:** `retrieve_knowledge` bugün yalnız Scribe'da — ASK/AKIS
   yoluna açmanın değeri/riski değerlendirilsin (read-only, gate-cap'siz kalır).

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
