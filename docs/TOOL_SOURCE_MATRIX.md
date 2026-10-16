# M1 首次啟用工具來源清單（#73 第一切片）

擷取日期：**2026-10-16**。本清單只核對供應商公開文件、發行資產名稱與發行端公布的 SHA-256；**沒有下載或執行任何工具二進位檔，也沒有完成授權審查、VSIX 打包或乾淨機器驗收**。「有資產」不等於「可以合法放進 VSIX」或「已在該平台運作」。固定版本是後續實作的候選鎖定點，更新時必須重新核對來源、完整性、相依授權與四平台執行結果。

## 用途與交付判定

| 工具 | 本專案用途 | 首次啟用判定 | 候選版本 | 再散布／使用者範圍佈署 |
| --- | --- | --- | --- | --- |
| Git | 工作樹與受管 terminal | 必需 | Windows `v2.56.0.windows.2`；macOS **未選定** | Git for Windows 是 Git GPL-2.0 加其他各自授權元件，須逐項清點／提供授權與源碼義務；Windows 有官方 PortableGit／MinGit 候選。macOS 的 Git 網站明說非原始碼發行由第三方提供，尚無符合本需求的固定、可驗證、可在使用者範圍佈署的官方二進位方案；**不能標 ready**。[Git for Windows 發行說明](https://github.com/git-for-windows/build-extra/blob/main/ReleaseNotes.md)、[macOS 安裝頁](https://git-scm.com/install/mac) |
| `gh` | 受管 terminal；擴充套件現有 GitHub 讀取使用 VS Code authentication | 依 #73 使用者需求為必需；不可授予 worker 直接寫入權限 | `v2.102.0` | [MIT 授權](https://github.com/cli/cli/blob/trunk/LICENSE)。四平台官方 zip 有發行端雜湊與 [Sigstore attestation 驗證流程](https://github.com/cli/cli#verification-of-binaries)；仍須將授權與第三方聲明納入 SBOM。[發行頁](https://github.com/cli/cli/releases/tag/v2.102.0) |
| Claude Code | 選用 provider 的原生 CLI | 選取此 provider 時必需 | `2.1.89`（官方文件的可固定版本範例） | 官方有使用者範圍安裝、四平台簽名 manifest 與平台簽章；**查不到允許本專案再散布二進位檔的明確授權**，不放進 VSIX。由擴充套件自行下載並驗簽／雜湊的方案也需條款審核；不得執行 `curl | sh`。[官方安裝與驗簽](https://code.claude.com/docs/en/setup) |
| Codex CLI | 選用 provider 的原生 CLI | 選取此 provider 時必需 | `rust-v0.163.0` | [原始碼 Apache-2.0](https://github.com/openai/codex/blob/main/LICENSE)；官方發行頁有四平台資產與雜湊，候選為 user scope 部署。VSIX 再散布仍須確認發行二進位及其相依資產的 notices／SBOM。[OpenAI Docs：CLI 安裝](https://learn.chatgpt.com/docs/codex/cli)、[發行頁](https://github.com/openai/codex/releases/tag/rust-v0.163.0) |
| agy | 選用 provider 的原生 CLI | 選取此 provider 時必需 | CLI changelog `v1.3.6`，**未取得固定資產** | Google 官方列出 macOS／Windows 使用者範圍安裝指令與 `agy --version`；查不到可鎖定的四平台直接二進位 URL、發行 SHA-256／簽章驗證規格或允許第三方再散布的明確授權。**四平台均未驗證，不能佈署或標 ready。**[官方快速入門](https://antigravity.google/docs/getting-started?tab=cli)、[CLI 版本紀錄](https://antigravity.google/docs/changelog?tab=cli)、[條款](https://www.antigravity.google/terms) |

登入仍由使用者經供應商正式流程完成；工具存在不代表登入成功、身份已核實、可讀額度或私人規則已注入。`gh` 必須受 #24 broker 控制，預裝它不構成寫入授權。

## 四平台固定資產與完整性證據

下表的 SHA-256 取自各供應商**發行端**在 2026-10-16 公布的 metadata／manifest。尚未自行下載檔案計算 SHA，也未在四平台啟動。`未驗證` 表示目前不能自動佈署；`候選` 仍需授權、下載後驗證與實機測試。

| 工具 | `darwin-x64` | `darwin-arm64` | `win32-x64` | `win32-arm64` |
| --- | --- | --- | --- | --- |
| Git | **未驗證**：無本清單可用的官方固定二進位 | **未驗證**：同左 | [PortableGit 2.56.0.2 x64](https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe) `075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b`（候選） | [PortableGit 2.56.0.2 ARM64](https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-arm64.7z.exe) `0f21e681bd33e006e0348dfa1a2be6769efd77e3bfdb247320314facde23a46c`（候選） |
| `gh` | [macOS amd64 zip](https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_macOS_amd64.zip) `b245f24eb2bf5f75b426b4c26da3651a107f8d5b6f4fddfbfccc5679041378b3` | [macOS arm64 zip](https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_macOS_arm64.zip) `da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e` | [Windows amd64 zip](https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_windows_amd64.zip) `ae64e556ecc240b200f7eba60d550e4bb60d78e860e69dd88c449405b86067f4` | [Windows arm64 zip](https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_windows_arm64.zip) `5dcf12aa8525eabd0c46ec414f323ab6cf65229fc2cd46543cc705001bbaf223` |
| Claude Code | 官方 [2.1.89 manifest](https://downloads.claude.ai/claude-code-releases/2.1.89/manifest.json) `darwin-x64`：`1322c5eecec8047e9cd7114f7d547ef6a9596563d6bbc7e594167d0f8bc8b406`；直接資產 URL 未核對 | 同一 manifest `darwin-arm64`：`f903a5e53f845b1ac5566296b713193827665f28da16300fdca7539cb0669a7f`；直接資產 URL 未核對 | 同一 manifest `win32-x64`：`2e312000b538f11d13f1dfc52d4131996895b9a07bd8897d8f9153635d4ea092`；直接資產 URL 未核對 | 同一 manifest `win32-arm64`：`5f1d597c542aac3a11f557e12c92d0c49220ab77e741014b0599a572d81ca679`；直接資產 URL 未核對 |
| Codex CLI | [x86_64 Apple tar.gz](https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-x86_64-apple-darwin.tar.gz) `562a1aea0e5686283a467687d268ae33705f02fd4d40f1bc4110a415c5c1c7b1` | [aarch64 Apple tar.gz](https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-aarch64-apple-darwin.tar.gz) `61c4d9a92521bdb42b0c1d9f87c673f6da628a06de5945cbdd9a0010632f6d10` | [x86_64 Windows exe](https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-x86_64-pc-windows-msvc.exe) `2692c8c7bb2cf8b0aefe638741fc90236f4b824c59578ce84994f9de58200993` | [aarch64 Windows exe](https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-aarch64-pc-windows-msvc.exe) `babd1ee5a76e4299d18f7ef99aa39d330e176e837566d3e2325d9b6b64e1ca61` |
| agy | **未驗證**：查不到固定資產與雜湊 | **未驗證**：同左 | **未驗證**：同左 | **未驗證**：同左 |

`gh`、Git for Windows 與 Codex 的 hash 來自對應 GitHub Releases 官方 API `assets[].digest`，並可在上述發行頁逐項核對。Claude 的值來自官方 manifest；官方文件列出 manifest 的 GPG 簽名、金鑰指紋 `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`，以及 macOS notarization／Windows Authenticode 驗證方式；**本次尚未執行簽章驗證**。[官方驗證說明](https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing)

## VSIX 與安裝能力結論

VS Code 官方支援 `darwin-x64`、`darwin-arm64`、`win32-x64`、`win32-arm64` 四種 platform-specific VSIX，`vsce package --target` 可選目標；這只解決按平台放檔案，**不會自動取得第三方再散布授權，也不是安裝時執行 OS 套件管理器的 hook**。[VS Code 平台 VSIX 文件](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platform-specific-extensions)、[activation event](https://code.visualstudio.com/api/references/activation-events)

後續實作至少需要：

1. 為每個被允許部署的平台鎖定版本、官方 HTTPS URL、SHA-256／簽章、公鑰指紋、執行檔相對路徑與授權 notices；維護 SBOM。缺任一證據時顯示「未驗證」，不下載後直接執行。
2. 優先使用本機擴充套件私有工具目錄與原子 staging；校驗完成後才切換受管 PATH。中斷、離線、版本不符或路徑遭替換時保留上次已驗證版本，並顯示修復入口。移除只清理由擴充套件管理的版本，不碰使用者原有工具、登入與設定。
3. macOS Git、Claude Code 再散布／直接資產、agy 固定資產／完整性／授權是目前阻擋點。不得以 Homebrew、winget、`curl | sh`、WSL 或供應商以外鏡像填補這些空缺；乾淨機器 M1 安裝驗收仍未通過。

## 本切片驗證邊界

只查閱官方頁面、官方 GitHub 發行 metadata 與 Claude 公開 manifest；沒有下載、安裝、登入或執行真實 CLI。沒有驗證四平台二進位實際 hash、簽章、可執行性、VSIX 內容、授權履行、原生 terminal PATH、升級／移除與乾淨機器體驗。這些是 #73 後續 PR 和使用者實機驗收的工作。
