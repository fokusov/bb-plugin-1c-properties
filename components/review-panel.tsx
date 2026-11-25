import { useEffect, useState } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker, useBbNavigate, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import type { ExperimentalProviderModelPickerValue, ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { reviewContract, reviewTarget } from "../review-contract.js";

type ReviewList = z.infer<typeof reviewContract.reviewList.output>;
const EVIDENCE_LABELS = {
  "missing-review": "В исходной копии отсутствует review.json. Если ревью обязательно, BSL Flow не пропустит изменение.",
  "review-present": "В исходной копии найден review.json. Актуальность и допустимость проверяет BSL Flow.",
  unavailable: "Локальное изменение BSL Flow в исходной копии не обнаружено.",
};

export function ReviewPanel({ threadId, environment }: ExperimentalThreadTabProps) {
  if (!environment) return <p>Для второго мнения открой тред с рабочей копией Git.</p>;
  return <ReviewForm key={`${threadId}/${environment.id}`} threadId={threadId} environmentId={environment.id} />;
}

function ReviewForm({ threadId, environmentId }: { threadId: string; environmentId: string }) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof reviewContract>();
  const [head, setHead] = useState("");
  const [targetKind, setTargetKind] = useState<"git" | "openspec">("git");
  const [base, setBase] = useState("");
  const [change, setChange] = useState("");
  const [taskId, setTaskId] = useState("");
  const [brief, setBrief] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [execution, setExecution] = useState<ExperimentalProviderModelPickerValue | null>(null);
  const [reviews, setReviews] = useState<ReviewList>([]);
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    rpc.call("reviewContext", { threadId, environmentId }).then(({ head }) => {
      if (active) setHead(head);
    }).catch((cause: unknown) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [rpc, threadId, environmentId, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    const request = { threadId, signal: controller.signal };
    void Promise.all([sdk.threads.get(request), sdk.threads.defaultExecutionOptions(request)]).then(([thread, opts]) => {
      if (!controller.signal.aborted && thread.providerId && opts?.model) {
        setExecution({ providerId: thread.providerId, model: opts.model, reasoningLevel: opts.reasoningLevel });
      }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => controller.abort();
  }, [sdk, threadId]);

  useEffect(() => {
    let active = true;
    let pending = false;
    const update = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await rpc.call("reviewList", { threadId, environmentId });
        if (active) { setReviews(result); setStatusError(""); }
      } catch (cause) {
        if (active) setStatusError(String(cause));
      } finally {
        pending = false;
      }
    };
    void update();
    const timer = setInterval(() => void update(), 5_000);
    return () => { active = false; clearInterval(timer); };
  }, [rpc, threadId, environmentId, refresh]);

  const target = reviewTarget.safeParse(targetKind === "git" ? { kind: "git", base: base.trim(), head }
    : { kind: "openspec", change: change.trim(), head });

  async function start() {
    if (!target.success || !execution || !accepted) return;
    setBusy(true);
    setError("");
    try {
      const result = await rpc.call("reviewStart", { threadId, environmentId, target: target.data,
        taskId: taskId.trim(), brief: brief.trim(), providerId: execution.providerId,
        model: execution.model, reasoningLevel: execution.reasoningLevel,
        ...(execution.serviceTier ? { serviceTier: execution.serviceTier } : {}), isolatedWorktree: true });
      setAccepted(false);
      setRefresh((value) => value + 1);
      navigate.toThread(result.threadId);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function checkEvidence(review: ReviewList[number]) {
    if (review.target.kind !== "openspec") return;
    setEvidence((previous) => ({ ...previous, [review.threadId]: "Проверяю…" }));
    try {
      const result = await rpc.call("reviewEvidence", { threadId, environmentId, change: review.target.change });
      setEvidence((previous) => ({ ...previous, [review.threadId]: EVIDENCE_LABELS[result] }));
    } catch (cause) {
      setEvidence((previous) => ({ ...previous, [review.threadId]: String(cause) }));
    }
  }

  return <main className="h-full overflow-auto p-4 text-sm"><div className="grid gap-3">
    <h2 className="font-semibold">Второе мнение</h2>
    <div className="flex flex-wrap items-center gap-2">
      <span>Ревизия <code>{head || "—"}</code></span>
      <button type="button" className="rounded border px-2" onClick={() => { setError(""); setHead(""); setRefresh((value) => value + 1); }}>Обновить</button>
    </div>
    <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void start(); }}>
      <label className="grid gap-1">Задача<input className="rounded border bg-transparent p-1" value={taskId} maxLength={160} onChange={(event) => setTaskId(event.target.value)} required /></label>
      <label className="grid gap-1">Материалы
        <select className="rounded border bg-transparent p-1" value={targetKind} onChange={(event) => setTargetKind(event.target.value === "openspec" ? "openspec" : "git")}>
          <option value="git">Диапазон Git</option><option value="openspec">Изменение OpenSpec</option>
        </select>
      </label>
      {targetKind === "git"
        ? <label className="grid gap-1">Начальный коммит, полный хеш<input className="rounded border bg-transparent p-1" value={base} maxLength={64} onChange={(event) => setBase(event.target.value)} required /></label>
        : <label className="grid gap-1">Идентификатор изменения OpenSpec<input className="rounded border bg-transparent p-1" value={change} maxLength={120} onChange={(event) => setChange(event.target.value)} required /></label>}
      <label className="grid gap-1">Вопрос и фокус ревью<textarea className="rounded border bg-transparent p-1" value={brief} maxLength={4000} onChange={(event) => setBrief(event.target.value)} required /></label>
      {execution && <div className="flex flex-wrap items-center gap-2"><span>Модель рецензента</span><ProviderModelPicker value={execution} onChange={setExecution} routing={{ kind: "environment", environmentId }} /></div>}
      <p>BB создаст отдельный worktree из выбранной ревизии. Запуск использует <code>accept-edits</code>, который разрешает запись в эту копию. Незакоммиченные материалы в ревью не попадут.</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />Использовать отдельную рабочую копию</label>
      <button type="submit" className="w-fit rounded border px-3 py-1 disabled:opacity-50" disabled={busy || !accepted || !target.success || !execution || !taskId.trim() || !brief.trim()}>{busy ? "Запуск…" : "Запустить ревью"}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <section className="grid gap-2">
      <h3 className="font-semibold">Обсуждения</h3>
      <p>Обязательное ревью проходит по маршруту BSL Flow. Его состояние проверяется в OpenSpec.</p>
      {statusError && <p role="alert">{statusError}</p>}
      {reviews.map((review) => <article key={review.threadId} className="grid gap-1 rounded border p-2">
        <div>{review.title ?? review.taskId} · {review.status}</div>
        <div>{review.model}</div>
        <button type="button" className="w-fit rounded border px-2" onClick={() => navigate.toThread(review.threadId)}>Открыть результат и обсуждение</button>
        {review.target.kind === "openspec" && <button type="button" className="w-fit rounded border px-2" onClick={() => void checkEvidence(review)}>Проверить наличие доказательства BSL Flow</button>}
        {evidence[review.threadId] && <p role="status">{evidence[review.threadId]}</p>}
      </article>)}
    </section>
  </div></main>;
}
