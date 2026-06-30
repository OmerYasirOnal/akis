# Yeni session'a verilecek prompt — demo-öncesi 3 PR'lık fix paketi (2026-06-12)

> Kaynak: `docs/research/demo-sweep-2026-06-12/demo-plan.html` (canlı tarama raporu) +
> `docs/research/2026-06-11-demo-blocker-audit.md`. Aşağıdaki bloğu olduğu gibi yeni session'a yapıştır.

---

Demo-öncesi fix paketi: aşağıdaki bulguları **3 ayrı PR'da** çöz. Taban: main `9c9a3e1` (PR #156+#157 merge'li demo sürümü). Çalışma disiplini repo `CLAUDE.md` "Working method"te — her PR için: izole worktree (İLK ADIM: `git log --oneline -1` + güncel local main SHA'sına reset), fail-first test, `pnpm -r typecheck` + backend & frontend vitest TAM yeşil + TR/EN i18n parity, paralel `akis-gate-keeper` + `akis-reviewer` çifti (MED+ bulgular merge'den önce kapanır), ayrı portta canlı doğrulama, kanıt `docs/research/` altına. PR'ları owner merge eder; push'tan önce `gh pr view` ile branch durumunu kontrol et, CI'ı yeşile kadar izle. Kutsal invariant'lar: 4 yapısal gate asla zayıflamaz; orchestrator emisyonlarına dokunuş yalnız ADDITIVE/observability-only olabilir; mevcut test assertion'ları gevşetilmez.

## PR-1 (en öncelikli): Push-gate'te "▶ Uygulamayı çalıştır" canlı sayfada çıkmıyor — F5 gerekiyor

**Canlı repro (2026-06-12 taramasında 2× üretildi):** statik bir uygulama build et → run `awaiting_push_confirm`'e gelsin → push-gate kartı göründüğü anda sayfada HİÇBİR Run butonu yok (drawer "Canlı görmek için uygulamayı çalıştır." hint'ini gösteriyor ama buton yok) → F5 sonrası "▶ Uygulamayı çalıştır" geliyor. Aynı davranış build sürerken sayfayı açıp (mid-run reload) gate'e gelen sayfada da var — yani hem hiç-reload'suz hem mid-run-reload'lu sayfada repro oluyor.

**Kod bağlamı:** `frontend/src/chat/ChatStudio.tsx:496` → `canRun = !!activeSessionId && !!codeFiles?.length && (isDone || isPreviewableStatus(backendStatus))`; `PREVIEWABLE_STATUSES` (`ChatStudio.tsx:45`) `awaiting_push_confirm`'i İÇERİYOR. Yani bayat kalan girdi büyük olasılıkla `codeFiles` (gate anında snapshot yeniden okunmuyor); `ChatStudio.tsx:318` civarındaki park/recovery yolu #156'da snapshot re-read kazandı ("re-reads the durable status so canRun flips live") ama awaiting-gate yolu kazanmadı. **Önce hangi yarının bayat olduğunu testle kanıtla** (codeFiles mı backendStatus mu), sonra fix'i gate olayına (awaiting_push_confirm + awaiting_critic_resolution) bağlı snapshot re-read olarak uygula — #156'daki park re-read'inin kapı kardeşi. Owner ilkesi: "Proto çalışan kod yazdıysa her halükârda preview edebilmeliyiz."

**Fail-first test:** SSE ile gate olayı gelen (reload'suz) oturumda Run butonunun render olduğunu assert et; mevcut park-yolu testlerini örnek al (`PreviewPanel.test.tsx` / `ChatStudio.test.tsx`).

## PR-2: Demo-görünür UI cilası (3 küçük iş, tek PR)

1. **Critic ajan şeridi build boyunca "beklemede" kalıyor** — run bloğu "Kod incelemesi · Onaylandı · N bulgu" derken üstteki roster'da Critic hiç aktifleşmiyor (canlı teyitli). `code_review` olayı var ama Critic için `agent_start/agent_end` emit edilmiyor. İki seçenek: (a) backend review yoluna senkron synthetic start/end çifti (Scribe'ın chat-seeded kalıbı gibi, `Orchestrator.ts:260/267` civarı — SALT observability, gate emisyonları byte-identical kalmalı; gate-keeper'a özellikle bunu kanıtlat) veya (b) FE'de `code_review` → şerit eşlemesi. Hangisi daha az riskliyse onu seç, gerekçele.
2. **Daralan spec çipi sonsuza dek "Spec onaylandı — inşa ediliyor"** (`SpecCard.tsx:88` statik metin) — doğrulanmış/bitmiş/yeniden açılmış build'de bile. Karta run durumunu yansıtan prop geçir; duruma göre kopya (building → mevcut, verified/done → "İnşa edildi" benzeri). TR+EN katalog anahtarlarıyla.
3. **Final kartı ham provider slug'ı basıyor** ("Yayınlandı … · anthropic"; `ChatThread.tsx:253` `m.provider` verbatim; mock'ta "· mock") — slug→görünen ad eşlemesi (anthropic→Anthropic (Claude), openai→OpenAI, openrouter→OpenRouter, google→Google (Gemini), mock→Demo).

Üçü de FE-ağırlıklı; (1)(a) seçilirse backend dokunuşu observability-only. Her madde için fail-first test + TR/EN parity.

## PR-3: `fix/confirmpush-resilient-writes` branch'ini merge'e hazırla

Branch ZATEN YAZILMIŞ durumda (worktree `.claude/worktrees/agent-a46bdd6ae5269c1b0`, HEAD `2663142`): `Orchestrator.ts` ~`:748/:766/:780` confirmPush terminal yazımlarının üçü de A1'in `updateResilient` bounded-retry kalıbına alınmış + 4 test. (Gerekçe: gerçek GitHub push'u 5-15 sn; bu sırada bir sohbet turu versiyonu artırırsa bayat-versiyon yazımı "version conflict" → push GitHub'a GİTMİŞKEN kullanıcıya ham 500 + oturum `awaiting_push_confirm`'de asılı — demonun final anı riski.) Yapılacak: branch'i güncel main üzerine rebase et/teyit et, diff'i kendin de incele, gate-keeper + reviewer çiftinden geçir, süitleri tam yeşil koş, PR aç ve owner merge'ine sun. Branch'te eksik/yanlış bir şey bulursan düzelt — körlemesine PR'lama.

## Canlı doğrulama — izole stack tarifi (owner'ın :3000/:5173'üne ASLA dokunma)

Bu oturumda doğrulanmış, birebir çalışan teknik:
1. `git worktree add --detach .claude/worktrees/<ad> <main-SHA>` + `pnpm install --prefer-offline`.
2. `cp backend/.env <worktree>/backend/.env` ve kopyadan **`DATABASE_URL` satırını SİL** (silmezsen owner'ın dev Postgres'ine bağlanırsın; silince izole in-memory/file store).
3. Backend `.env`'i OTOMATİK OKUMAZ: `HOME=/tmp/<izole-home> PORT=3001 AKIS_ENV_FILE=<worktree>/backend/.env pnpm -C <worktree>/backend dev` (HOME izolasyonu dev-events + store + workspaces'i ayırır).
4. Frontend: worktree `frontend/vite.config.ts` içinde `127.0.0.1:3000` → `127.0.0.1:3001` sed'le (uncommitted kalır, commit'leme); `pnpm -C <worktree>/frontend dev --port 5175 --strictPort` — **`--` ayracı KOYMA** (vite'a sızıyor, port flag'i yutuluyor, 5173/5174'e düşüyor!). Vite IPv6 `::1`'e bağlanır; health-check `http://localhost:5175` ile (127.0.0.1 değil).
5. Tarayıcı otomasyonu tek-sahipli; profil kilidi hatası alırsan `chrome-automation-profile` işaretli artık otomasyon süreçlerini öldür (kullanıcının gerçek Brave'ine dokunma).
6. PR-1 canlı kanıtı: gate anında reload'SUZ sayfada Run butonunun göründüğünü screenshot'la; PR-3 için push-confirm sırasında sohbet turu atan yarış senaryosu test düzeyinde yeterli.

Bittiğinde: `docs/plans/2026-06-10-demo-ready-plan.md`'ye durum notu düş + session memory güncelle. Bu paketin amacı 3-4 dk'lık sunum demosu — öncelik sırası PR-1 → PR-2 → PR-3, ama PR-3 büyük ölçüde hazır olduğundan paralel worktree'de eşzamanlı yürütülebilir.

---
