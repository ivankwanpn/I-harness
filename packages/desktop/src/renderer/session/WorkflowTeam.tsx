import { useSettingsDraft } from "../settings/settings-drafts.tsx"
import { Button } from "../vendor/opencode/Button.tsx"
import { useId } from "react"
import type { DesktopWorkflowView } from "@i-harness/desktop-gateway/src/workflow.ts"
import type { WorkflowMutate } from "./WorkflowGoalPlan.tsx"
import { useWorkflowText } from "./workflow-i18n.ts"
import { WorkflowStatus } from "./WorkflowStatus.tsx"

type Team = DesktopWorkflowView["team"]
type Member = Team["members"][number]
type Task = Team["tasks"][number]
// Matches the roster's public identifier contract; do not loosen backend trust.
const validMemberName = (name: string) => name.length <= 64 && name !== "lead" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)

export function WorkflowTeam({ workspaceId, sessionId, team, disabled, planMode, running, mutate }: { workspaceId: string; sessionId: string; team: Team; disabled: boolean; planMode: boolean; running: boolean; mutate: WorkflowMutate }) {
  const t = useWorkflowText()
  const scope = ["workflow", workspaceId, sessionId, "team"]
  const [name, setName] = useSettingsDraft([...scope, "member-name"], "")
  const [description, setDescription] = useSettingsDraft([...scope, "member-description"], "")
  const [prompt, setPrompt] = useSettingsDraft([...scope, "member-prompt"], "")
  const [context, setContext] = useSettingsDraft<"fresh" | "fork">([...scope, "member-context"], "fresh")
  const [subject, setSubject] = useSettingsDraft([...scope, "task-subject"], "")
  const [taskDescription, setTaskDescription] = useSettingsDraft([...scope, "task-description"], "")
  const [creating, setCreating] = useSettingsDraft([...scope, "creating"], false)
  const memberNameId = useId(), memberNameHintId = `${memberNameId}-hint`, memberNameErrorId = `${memberNameId}-error`
  const nameValid = validMemberName(name), nameInvalid = name !== "" && !nameValid
  const blocked = disabled || !team.enabled || planMode
  return <div className="workflow-team">
    {!team.enabled ? <p role="status" className="muted">{t("此會話未啟用團隊工具")}</p> : null}
    {planMode ? <p role="status" className="muted">{t("請先退出計畫模式再管理團隊。")}</p> : null}
    <section className="workflow-section" aria-label={t("成員")}>
      <h2>{t("成員")}</h2>
      <article className="workflow-card workflow-lead" aria-label={t("主代理 · 本會話")}>
        <div className="workflow-heading"><h3>{t("主代理 · 本會話")}</h3><WorkflowStatus status={running ? "running" : "idle"} label={t(running ? "執行中" : "閒置")} /></div>
      </article>
      {team.members.length ? <div className="workflow-list">{team.members.map((member) => <MemberCard key={`${member.id}:${member.name}`} workspaceId={workspaceId} sessionId={sessionId} member={member} disabled={blocked} mutate={mutate} />)}</div> : <p className="workflow-empty">{t("尚未建立團隊成員")}</p>}
      <details className="workflow-card workflow-create" open={creating} onToggle={event => setCreating(event.currentTarget.open)}><summary>{t("建立團隊成員")}</summary>
        <form onSubmit={async (event) => {
          event.preventDefault()
          if (blocked || !nameValid || !description.trim() || !prompt.trim()) return
          if (await mutate({ action: "team", tool: "spawn_teammate", args: { name, description: description.trim(), prompt: prompt.trim(), context } })) { setName(current => current === name ? "" : current); setDescription(current => current === description ? "" : current); setPrompt(current => current === prompt ? "" : current) }
        }}>
          <div className="workflow-two-columns"><div className="workflow-member-name"><label htmlFor={memberNameId}>{t("成員名稱")}<input id={memberNameId} required maxLength={64} pattern="(?!lead$)[a-z0-9]+(?:-[a-z0-9]+)*" aria-describedby={`${memberNameHintId}${nameInvalid ? ` ${memberNameErrorId}` : ""}`} aria-invalid={nameInvalid || undefined} disabled={blocked} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <p id={memberNameHintId} className="workflow-hint">{t("使用小寫字母和數字，可用連字號分隔；最多 64 字，不可使用 lead。")}</p>{nameInvalid ? <p id={memberNameErrorId} role="alert" className="error-text">{t("請按名稱規則修改；目前草稿仍保留。")}</p> : null}</div>
          <label>{t("成員上下文")}<select disabled={blocked} value={context} onChange={(event) => setContext(event.target.value as "fresh" | "fork")}><option value="fresh">{t("全新上下文")}</option><option value="fork">{t("繼承目前對話")}</option></select></label></div>
          <label>{t("成員職責")}<input required maxLength={2000} disabled={blocked} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label>{t("初始任務")}<textarea required rows={3} maxLength={8000} disabled={blocked} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
          <p className="workflow-hint">{t("建立後會啟動新成員並執行初始任務。")}</p>
          <Button variant="primary" size="small" type="submit" disabled={blocked || !nameValid || !description.trim() || !prompt.trim()}>{t("建立成員")}</Button>
        </form>
      </details>
    </section>
    <section className="workflow-section" aria-label={t("共享任務")}>
      <h2>{t("共享任務")}</h2>
      {team.tasks.filter((task) => task.status !== "deleted").length ? <div className="workflow-board">{team.tasks.filter((task) => task.status !== "deleted").map((task) => <TaskCard key={task.id} task={task} members={team.members} disabled={blocked} mutate={mutate} />)}</div> : <p className="workflow-empty">{t("尚無共享任務")}</p>}
      <form className="workflow-card" onSubmit={async (event) => {
        event.preventDefault()
        if (blocked || !subject.trim() || !taskDescription.trim()) return
        if (await mutate({ action: "team", tool: "team_task_create", args: { subject: subject.trim(), description: taskDescription.trim() } })) { setSubject(current => current === subject ? "" : current); setTaskDescription(current => current === taskDescription ? "" : current) }
      }}>
        <label>{t("任務標題")}<input required maxLength={2000} disabled={blocked} value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
        <label>{t("任務說明")}<textarea rows={2} required maxLength={8000} disabled={blocked} value={taskDescription} onChange={(event) => setTaskDescription(event.target.value)} /></label>
        <p className="workflow-hint">{t("任務建立後可指派給成員。")}</p>
        <Button size="small" type="submit" disabled={blocked || !subject.trim() || !taskDescription.trim()}>{t("建立任務")}</Button>
      </form>
    </section>
  </div>
}

function MemberCard({ workspaceId, sessionId, member, disabled, mutate }: { workspaceId: string; sessionId: string; member: Member; disabled: boolean; mutate: WorkflowMutate }) {
  const t = useWorkflowText()
  const [message, setMessage] = useSettingsDraft(["workflow", workspaceId, sessionId, "member-message", member.id, member.name], "")
  const blocked = disabled || member.phase !== "active"
  async function send(tool: "send_message" | "followup_task") {
    if (!blocked && message.trim() && await mutate({ action: "team", tool, args: { target: member.name, message: message.trim() } })) setMessage(current => current === message ? "" : current)
  }
  return <article className="workflow-card" aria-label={t("成員 {name}", { name: member.name })}>
    <div className="workflow-heading"><h3>{member.name}</h3><WorkflowStatus status={member.phase} label={member.phase === "active" ? t("已就緒") : undefined} /></div>
    <p>{member.description}</p>{member.error ? <p className="error-text">{member.error}</p> : null}
    <p className="workflow-meta">{t(member.context === "fork" ? "繼承目前對話" : "全新上下文")}</p>
    <label>{t("訊息 {name}", { name: member.name })}<textarea rows={2} maxLength={8000} disabled={blocked} value={message} onChange={(event) => setMessage(event.target.value)} /></label>
    <div className="workflow-actions"><Button size="small" disabled={blocked || !message.trim()} onClick={() => { void send("send_message") }}>{t("傳送訊息")}</Button><Button size="small" disabled={blocked || !message.trim()} onClick={() => { void send("followup_task") }}>{t("派發後續任務")}</Button><Button size="small" variant="ghost" disabled={blocked} onClick={() => { if (!blocked) void mutate({ action: "team", tool: "interrupt_agent", args: { target: member.name } }) }}>{t("中斷成員")}</Button></div>
    <p className="workflow-hint">{t("傳送訊息不會啟動閒置成員；後續任務會啟動新的回合。")}</p>
  </article>
}

function TaskCard({ task, members, disabled, mutate }: { task: Task; members: Member[]; disabled: boolean; mutate: WorkflowMutate }) {
  const t = useWorkflowText()
  const owner = members.find((member) => member.id === task.ownerId)?.name ?? task.ownerId ?? ""
  function update(action: string, extra: Record<string, unknown> = {}) {
    if (disabled || action === "reassign" && task.status === "completed") return
    void mutate({ action: "team", tool: "team_task_update", args: { task_id: task.id, expected_revision: task.revision, action, ...extra } })
  }
  return <article className="workflow-card workflow-board-task">
    <div className="workflow-heading"><h3>{task.subject}</h3><WorkflowStatus status={task.status} /></div>
    <p>{task.description}</p><p className="workflow-meta">{t("修訂 {revision}", { revision: task.revision })}</p>
    {task.blockedBy.length ? <p className="workflow-meta">{t("相依任務")}：{task.blockedBy.join(", ")}</p> : null}
    {task.writeScopes.length ? <p className="workflow-meta">{t("寫入範圍")}：{task.writeScopes.join(", ")}</p> : null}
    <label>{t("負責成員 {name}", { name: task.subject })}<select disabled={disabled || task.status === "completed"} value={owner} onChange={(event) => update("reassign", { owner: event.target.value })}>
      <option value="">{t("未指派")}</option>
      {task.ownerId && !members.some((member) => member.name === owner) ? <option value={owner} disabled>{owner}</option> : null}
      {members.filter((member) => member.phase === "active").map((member) => <option key={member.id} value={member.name}>{member.name}</option>)}
    </select></label>
    <div className="workflow-actions"><Button size="small" disabled={disabled} aria-label={t(task.status === "completed" ? "重新開啟 {name}" : "完成任務 {name}", { name: task.subject })} onClick={() => update(task.status === "completed" ? "reopen" : "complete")}>{t(task.status === "completed" ? "重新開啟 {name}" : "完成任務 {name}", { name: task.subject })}</Button></div>
  </article>
}
