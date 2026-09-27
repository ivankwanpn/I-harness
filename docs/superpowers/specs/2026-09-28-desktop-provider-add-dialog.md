# Desktop custom provider creation dialog

## Intent

The current **新增提供商** action expands a full-width, seven-field editor above the provider navigation. The form incorrectly says **編輯提供商** and explains override clearing even though this is a new record. On a normal desktop window, the provider list moves below the fold. ZCode keeps the provider list/detail visible while offering creation as a focused action.

## Behavior

- The existing add button opens a centered, accessible dialog. It uses the same local settings dialog mechanics as the subagent role editor: initial focus, contained Tab order, Escape/backdrop close, busy guard and focus return. There is no separate provider write path.
- New-provider fields show provider ID, display name, API URL and protocol first. Models URL, card catalog and API-key environment variable sit in an optional **進階設定** disclosure. Inputs remain optional except the provider ID, matching the current backend contract. The creation helper text must not describe clearing an existing override.
- Existing provider/model editing keeps the same `ProviderEditor` semantics. The form titles distinguish **新增** from **編輯**. Backend `provider/create` still validates identity, URLs, protocol and allowed fields. A failed mutation keeps the form and error visible; in-flight save cannot close the dialog.
- Once creation succeeds, the provider directory refreshes and selects the newly created ID. The user can then add its model and credential through the already wired controls. No credential is echoed or sent by creation.
- New UI does not create a provider or call a model during visual inspection. Existing provider data and the user-edited Vite config remain untouched.

## Verification

- Red-green tests cover add-dialog focus/dismissal, clear creation copy/basic+advanced fields, error visibility and selecting the created provider; role-dialog regression stays green.
- Desktop full suite and typecheck pass. Packaged Electron at normal/narrow widths shows the dialog without horizontal overflow; Escape restores focus. The final artifact is rebuilt, with no GitHub push or `D:\I-harness-main` edit.
