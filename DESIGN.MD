# Boosted

**Version:** 1.0 · **Prepared:** 2026-10-02 · **Reference theme:** dark · **Target:** desktop-first application UI

## 1. How to use this document

Use this file as the design contract for a desktop client or a web application that should resemble the supplied references. Build reusable components and route templates rather than reproducing each screenshot as a fixed picture.

Three evidence labels apply throughout:

- **[Observed]** A structure, visible state, or solid interior color present in a supplied screenshot. Pixel measurements refer to the uploaded raster, not verified CSS pixels or macOS points.
- **[Approximate]** A practical token inferred from visible geometry, text rendering, or composited materials. Font files, exact weights, device scale, opacity, and blur cannot be recovered reliably from these images.
- **[Recommended]** A new implementation rule for behavior, accessibility, responsiveness, or an unsupplied state. It is not an assertion about Codex's actual behavior.

**Priority:** preserve the overall geometry and information hierarchy; preserve the distinction between screen types; use the sampled surfaces; then refine typography, icons, and micro-spacing. Production accessibility requirements take precedence over reproducing a low-contrast pixel exactly.

All dimensions are nominal CSS-pixel implementation targets unless explicitly described as screenshot coordinates. A 16px browser root font size is the calibration baseline; text uses `rem` so user text-size preferences remain meaningful.

### 1.1 Reference inventory

| ID | Supplied file | Raster size | Visual evidence |
| --- | --- | --- | --- |
| S01 | `image(20261002-014512).png` | 1415 × 1027 | Messenger conversation; global rail; workspace navigation; single-line composer |
| S02 | `image(20261002-014519).png` | 1432 × 1033 | Same messenger layout with an open agent-details popover |
| S03 | `image(20261002-014528).png` | 1433 × 1030 | Task conversation; unboxed assistant output; attachment preview; quota notice; expanded composer |
| S04 | `image(20261002-014533).png` | 429 × 355 | Account menu crop, identity row, selected menu row, shortcut hints |
| S05 | `image(20261002-014544).png` | 1419 × 1037 | General settings; grouped rows; switches; dropdowns; long descriptions |
| S06 | `image(20261002-014558).png` | 851 × 317 | Multi-select menu; checkmarks; trigger count; compact menu rows |
| S07 | `image(20261002-014608).png` | 1420 × 1031 | Plugins settings; heading actions; tabs; search; unboxed integration rows |
| S08 | `image(20261002-014624).png` | 1426 × 1030 | Connections settings; tabs; device group; grouped switches and secondary actions |

The screenshots include native window framing and small strips of unrelated content outside the application. Exclude those strips, the desktop wallpaper, and background applications from the design. The filenames above identify the supplied references; the design kit does not redistribute them.

### 1.2 Public references and their limits

OpenAI publishes `@openai/apps-sdk-ui`, which provides design tokens and React components for experiences inside ChatGPT. Its public UI guidelines favor system typography, restrained palettes, consistent spacing, and understated outlined iconography. These are useful supporting principles, but they do not establish the desktop shell's dimensions or private component architecture. [O1, O2]

Do not apply embedded-plugin rules mechanically to an entire desktop app. For example, restrictions on deep navigation or nested scrolling inside an inline plugin card are not rules against a desktop sidebar or an independently scrolling conversation.

## 2. Visual direction

The interface is a **matte, neutral, compact desktop workspace**, not a marketing page or a dashboard made of cards.

The darkest large surface is the main canvas. The sidebar is slightly lighter. The rail and titlebar form a continuous medium-dark frame. Controls, selections, message bubbles, and overlays use local steps in gray rather than strong outlines or decorative shadows. [S01–S08]

Navigation is dense, while the main content is constrained to a readable center column. Empty space is intentional: the plugins screen contains only a few rows, and the rest of the canvas remains empty. Settings do not expand into a multi-column card grid merely because space is available. [S05, S07, S08]

### Non-negotiable visual rules

1. Use neutral grays, not a blue-black or purple-black theme. Blue is an interaction/status accent, not the background system.
2. Keep the narrow global rail and the wider contextual sidebar as distinct regions.
3. Center content within the **main pane**, not within the full window.
4. Keep the conversation and composer on the same horizontal grid.
5. Use grouped bordered surfaces for settings, but leave plugin rows and task assistant output unboxed.
6. Use messenger bubbles and task transcript styling as separate modes. Never render every assistant response as a gray bubble.
7. Keep permanent surfaces flat. Reserve noticeable shadows for menus and floating panels.
8. Use small outlined icons, regular-weight body text, and quiet secondary labels. Do not make every navigation item bold.
9. Use rounded rectangles for navigation, cards, and menus; use pills only where the reference does.
10. Avoid gradients, glow, glass effects across the app, oversized headings, ornamental illustrations, and generic overview widgets.

## 3. Color and surface system

### 3.1 Reference palette

Hex values for large flat regions were sampled from the supplied PNGs. Text values are approximations: antialiasing and compositing introduce many nearby grays. A sampled raster value is evidence of a displayed color, not proof of an original design token.

| Token suffix, under `--cdx-` | Reference value | Role | Evidence |
| --- | --- | --- | --- |
| `bg-canvas` | `#181818` | Main conversation/settings canvas | Observed: S01, S03, S05, S07, S08 |
| `bg-sidebar` | `#1E1E1E` | Contextual navigation | Observed: broad sidebar regions; some areas vary slightly |
| `bg-chrome` | `#272728` | Titlebar and global rail | Observed dominant value; composited areas vary |
| `bg-card` | `#232323` | Settings groups | Observed: S05, S06, S08 |
| `bg-banner` | `#212121` | Quota/status notice in task view | Observed: S03 |
| `bg-assistant-bubble` | `#2A2A2A` | Messenger assistant bubbles | Observed: S01, S02 |
| `bg-task-user` | `#2F2F2F` | Task user prompts | Observed: S03 |
| `bg-selected` | `#303030` | Selected sidebar row | Observed dominant value: S01, S05, S07, S08 |
| `bg-search` | `#303030` | Sidebar search | Observed: S05, S07, S08 |
| `bg-composer` | `#363636` | Messenger/task composer | Observed: S01, S03 |
| `bg-control` | `#2A2A2A` | Compact settings controls | Observed: S05 |
| `bg-control-raised` | `#383838` | Filled buttons in the details panel | Observed: S02 |
| `bg-popover` | `#2D2D2D` | Agent-details floating panel | Observed: S02 |
| `bg-menu` | `#2C2C2C` | Solid approximation for floating menus | Approximate: S04, S06 contain nearby shades |
| `bg-menu-hover` | `#3D3D3D` | Highlighted menu row | Approximate representative value: S04 |
| `bg-user-bubble` | `#6E8EB5` | Messenger outgoing message | Observed: S01, S02 |
| `text-primary` | `#FFFFFF` | Main text, labels, white button fill | White glyph interiors observed; use as target |
| `text-secondary` | `#CDCDCD` | Supporting body text, navigation | Approximate: S01, S03 |
| `text-description` | `#A8A8A8` | Settings descriptions | Approximate: S05 |
| `text-muted` | `#929292` | Timestamps, metadata, inactive controls | Approximate: S01–S03 |
| `text-sidebar-heading` | `#727272` | Low-emphasis navigation group headings | Approximate: S05 |
| `text-placeholder` | `#686868` | Empty composer hint | Approximate: S01, S03 |
| `border-subtle` | `#353535` | Group outline and inset row separators | Observed: S05, S08 |
| `border-control` | `#3C3C3C` | Quiet outline around controls | Approximate: S05 |
| `accent` | `#3A83F7` | Enabled switches; unread dots | Observed: S01, S05, S08 |
| `status-online` | `#40C977` | Small online/presence indicator | Observed sample: S01 |
| `avatar-green` | `#2ECC71` | Account-avatar fill | Observed: S01, S03, S08 |
| `avatar-lavender` | `#BAC1D3` | Agent-avatar fill | Observed: S02 |
| `warning` | `#E58B54` | Elevated-permission text/icon | Recommended approximation of S03's orange treatment |
| `danger` | `#FF8A8A` | Error/destructive emphasis | Recommended; not visible in the supplied screens |
| `focus-ring` | `#A7C7FF` | Keyboard-focus indicator | Recommended; not established by screenshots |

### 3.2 Surface composition

Keep borders at 1px. Settings groups have an outside border and inset internal separators; individual rows are not separate floating cards. Selected sidebar rows have a fill but no bright outline. The main canvas does not need a border around every subregion. [S05, S07, S08]

Do not substitute a simple global “elevation ladder” for semantic roles. The settings card is darker than a messenger bubble, while the composer is lighter than both. A larger component is not automatically lighter.

The native chrome and small menus show color variation consistent with compositing. **[Recommended]** Start with the solid fallback colors above. Introduce native material rendering only when the host supports it and a direct comparison demonstrates a better match. Do not invent CSS gradients to imitate incidental pixel variation.

### 3.3 Reference versus accessible contrast

The reference palette includes combinations that should not be copied unchanged into a production interface. Calculated using the listed solid sRGB values:

| Combination | Contrast ratio, rounded | Interpretation |
| --- | --- | --- |
| White on messenger blue `#6E8EB5` | 3.39:1 | Below the 4.5:1 threshold for ordinary small text |
| Muted `#929292` on popover `#2D2D2D` | 4.43:1 | Slightly below 4.5:1 |
| Placeholder `#686868` on composer `#363636` | 2.17:1 | Low-contrast reference treatment; do not use for essential input instructions |
| White on recommended blue `#47698F` | 5.70:1 | Meets the ordinary-text contrast threshold for this pair |
| `#AAAAAA` on composer `#363636` | 5.20:1 | Suitable placeholder/text pair at ordinary sizes |
| Control outline `#858585` against `#363636` | 3.27:1 | Meets the 3:1 non-text threshold for this pair |

**[Recommended]** Use the accessible profile as the default: darken the outgoing bubble to `#47698F`; lift metadata and sidebar headings to `#A8A8A8`; lift placeholders to `#AAAAAA`; and use `#858585` for required control outlines. Keep the subtle border for decorative group boundaries. The CSS in Section 16 implements these defaults; `data-cdx-contrast="reference"` is an explicit opt-in for visual-comparison fixtures.

These pairwise calculations are not a full accessibility audit. WCAG's ordinary-text contrast threshold is 4.5:1, while large text has a 3:1 threshold; required visual information identifying controls and states generally has a 3:1 non-text threshold. Exceptions and context still apply. [A1, A2]

## 4. Typography and iconography

### 4.1 Font system

**[Approximate]** Use a platform system sans-serif stack. The screenshots have a compact native-system appearance; they do not prove an exact font family, proprietary font file, or font version.

```css
--cdx-font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--cdx-font-mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
```

Use the default font metrics first. Do not load Inter or a custom display font just because it is available. Do not set a 14px root font size and then also apply the supplied `0.875rem` body token: that would shrink the entire type system twice.

| Role | Target size / line height | Weight | Usage |
| --- | --- | --- | --- |
| Page heading | 28 / 34px | 600 | General, Plugins, Connections |
| Sidebar title | 18 / 24px | 600 | Workspace title or Settings |
| Body / navigation | 14 / 20px | 400 | Messages, navigation rows, plugin names |
| Task prose | 14 / 22px | 400 | Unboxed assistant output |
| Section heading | 14 / 20px | 500 | Permissions, General, other settings groups |
| Control / row label | 13 / 18px | 400–500 | Settings label, compact button, menu item |
| Description / caption | 12 / 16px | 400 | Settings help, timestamps, device metadata |
| Monospace metadata | 12 / 16px | 400 | Paths or technical identifiers |

These are implementation targets inferred from S01–S08. Apply roughly `-0.025em` letter spacing only to the 28px heading; leave body tracking normal. Use bold within task prose for a specific result, not for entire paragraphs. Keep section labels sentence case; do not turn navigation groups into tiny uppercase labels.

### 4.2 Icons and imagery

**[Observed]** Most navigation and action icons are monochrome outlines. The active home symbol is more visually substantial. Small blue and green dots provide status. Brand icons retain their own artwork in integration rows. [S01, S02, S07]

**[Recommended]** Use a consistent outline family at approximately 1.5px stroke weight when drawing at a 16–20px size. Match visual weight rather than mixing several libraries. Default icon size is 16px in rows and 18px in compact buttons; global-rail symbols can be 18–20px. Chevron and status glyphs can be 12px.

Use a 40 × 40px integration-logo container with about a 10px radius. Account avatars are approximately 24px; the details-panel agent avatar is approximately 64px. The lavender ring-style avatar is a reference identity treatment, not a required brand asset for every app.

Do not stretch previews. Preserve their aspect ratio and use `object-fit: contain` where containment is needed. Never copy real project names, personal account names, local paths, conversations, or device identities from the screenshots into a public demo. Use neutral fixtures. Do not invent product entitlements from the visible labels.

## 5. Geometry, spacing, and the desktop shell

### 5.1 Layout model

```text
┌───────────────────────────────────────────────────────────────────────┐
│ Native / application titlebar                              ≈ 44px    │
├───────┬─────────────────────────┬─────────────────────────────────────┤
│Global │ Contextual sidebar      │ Main pane                           │
│rail   │                         │                                     │
│       │ Workspace or Settings   │  Centered content column            │
│≈52px  │ ≈290px                  │  Messenger/task: up to 736px        │
│       │                         │  Settings: up to 728px              │
│       │ Independently scrolling │                                     │
│Account│ navigation              │  Composer anchored below transcript │
└───────┴─────────────────────────┴─────────────────────────────────────┘
```

The titlebar spans the application. The rail and sidebar occupy the full remaining height. The main pane flexes; its content does not. [S01, S03, S05, S07, S08]

| Element | Approximate observed geometry | Implementation target |
| --- | --- | --- |
| Titlebar | 42–44px high inside the window | 44px; omit duplicate custom chrome under a native titlebar |
| Global rail | 50–52px wide | 52px |
| Contextual sidebar | 289–292px wide | 290px including divider |
| Messenger/task content | About 736px | `max-width: 736px` |
| Settings content | About 728px | `max-width: 728px` |
| Settings top offset | About 76–80px below the content area's top | 76px |
| Details popover | About 300px wide | 300px |
| Sidebar row | About 30px high, roughly 31–32px pitch | 30px minimum plus 1px block margins |
| Sidebar row horizontal inset | About 8px | 8px |
| Settings-group radius | About 16px | 16px |
| Messenger composer | About 44px high | 44px minimum |
| Task composer | About 98px high in S03 | 98px minimum, grow with content |
| Composer bottom inset | About 12–16px | 16px plus safe-area handling |

A normalized 1400px-wide application has approximately `1400 − 52 − 290 = 1058px` of main-pane width. A 736px conversation leaves 161px of free space on either side **within that pane**. This arithmetic is a useful calibration check, not a responsive breakpoint rule.

### 5.2 Spacing and radius scales

**[Recommended normalization]** Use spacing values `4, 8, 12, 16, 20, 24, 32, 40, 48, 56px`. Preserve the few geometry-specific measurements such as 30px rows, 44px titlebar, and 52px rail rather than forcing everything to a multiple of eight.

Use 4px between immediately consecutive bubbles from the same sender; 16px between message groups; 12px between bubble paragraphs; 16px settings-group padding; approximately 48–56px between major settings sections; and approximately 48px of breathing room before a task response.

Use 8px for small preview corners, 10px for selected navigation and compact controls, 16px for settings cards, 18px for menus and task prompts, 22px for messenger bubbles and composers, and 28px for the large quota banner. Pill radii are for small pill buttons, switches, and the single-line composer silhouette—not for every surface.

### 5.3 Window chrome and global rail

**[Observed]** The rail and titlebar share a similar surface. The rail contains a top active destination, several compact destinations, subtle separators, and the account avatar near the bottom. The titlebar includes native window controls on the left and application controls on the right. S03 also shows the task title in the titlebar.

**[Recommended]** When using a native window, retain native window controls and reserve their hit areas. In a browser implementation, do not add fake, nonfunctional close/minimize/maximize buttons. Do not duplicate the native frame inside the web view.

A custom titlebar's empty region may be draggable, but all buttons, tabs, links, and inputs must remain interactive. Platform-specific drag-region support belongs in the host adapter; it is not assumed by the CSS foundation.

The active rail destination uses a roughly 36px rounded backing plate inside the 52px rail. Give compact rail controls meaningful labels/tooltips. Keep the avatar anchored at the bottom through flex layout, not hard-coded screen coordinates.

### 5.4 Contextual navigation

Workspace navigation has a title/actions row, a new-conversation action, an agent/conversation entry, and sections for pinned items, projects, and recent tasks. Project children are indented approximately 24px from the top-level row start. Trailing environment labels and status dots occupy a reserved trailing area. [S01–S03]

Settings replaces the workspace list with a settings title, a search field, section labels, and icon-labeled destinations. In S08, the list is scrolled while the title/search area remains visible. Keep the title/search region separate from the scrolling list. [S05, S07, S08]

Use a full-row hit target. Preserve an 8px gutter around selected-row fills. Truncate long item labels on one line, reserving space for trailing status. Provide the full name through a tooltip or accessible name. Do not fade away actionable information without another way to read it.

**[Recommended]** Distinguish current, hovered, unread, offline, and disabled states. A gray project label alone does not prove that the reference item is disabled. Navigation selection should remain visible when the pointer leaves. Use `aria-current="page"` for the current destination.

## 6. Conversation templates

### 6.1 Messenger mode

**[Observed: S01, S02]** This is a two-sided messenger layout, not the task transcript.

Assistant messages are left-aligned gray bubbles, up to approximately 648px inside the 736px column—about 88% of its width. User messages are right-aligned dusty-blue bubbles and size to their contents. Both use white primary text. Bubbles have smooth rounded corners without tails.

Use approximately 10px vertical and 16px horizontal padding, 14/20px text, and a 22px radius. A short single-line message is about 40px high. Stack consecutive assistant bubbles with a small 4px gap rather than treating every bubble as a new turn.

Date/time separators are centered in muted 12px text, with more space above than below. A read receipt appears below the relevant outgoing message and aligns toward its right edge. Links within assistant bubbles are underlined and inherit the bubble text color. Paragraphs remain visibly separated. [S01]

The conversation's agent identity is presented near the top; a call action is placed at the upper right. The exact sticky/overlap behavior cannot be established from the screenshots. **[Recommended]** Keep this header lightweight and do not add a large toolbar or a second persistent sidebar.

### 6.2 Task mode

**[Observed: S03]** Task user prompts use a neutral `#2F2F2F` bubble aligned right. Assistant output is unboxed on the canvas and can use the full column width.

A task response starts with a muted, clickable-looking work-duration summary and a small chevron. A thin horizontal separator sits underneath. Below it, assistant prose uses approximately 14/22px text, normal paragraphs, selective emphasis, and optional output previews. A small row of action icons and optional time metadata follows the response.

Task turns are airier than messenger messages. Start with about 48px between a prompt and its assistant response, and about 48px between completed turn groups, then compare against S03. Let the response height follow actual content; never hard-code its screenshot height.

An image output preview in S03 is about 332px wide. Use a constrained preview with a thin border and small corners; preserve the source aspect ratio. **[Recommended]** Open it in a properly labeled viewer when activated. Other artifacts should use filename/type/size/status rows, not fake thumbnails.

**Critical:** the neutral prompt bubble, transparent assistant response, work-summary divider, and output/action area define task mode. Switching to this mode must not leave messenger blue on user prompts or put the assistant inside a large card.

### 6.3 Content, markdown, and code extensions

**[Recommended; detailed code/diff states are not shown]** Keep prose semantic and selectable. Use actual paragraphs, lists, headings, blockquotes, and links. Scale message headings conservatively: approximately 18–20px for an in-message major heading rather than reusing the 28px page title.

Render fenced code in a restrained dark surface with 12–13px monospace text, a language label, and a copy action. Confine horizontal scrolling to genuinely wide code or tables; do not make the entire conversation horizontally scrollable. Wrap long prose and URLs safely. Keep long-form tables accessible and do not convert every output to a card.

Diff colors should be subdued and accompanied by addition/deletion markers, not color alone. These are compatible extensions, not reconstructed screens. Do not add a code editor, terminal, or docked right panel by default: their contents and layout are not established by these references.

### 6.4 Scrolling and streaming behavior

**[Recommended]** Make the transcript the scrolling region and the composer a separate bottom layout region. Avoid a document-level scroll that moves the entire shell or composer off-screen. Set `min-height: 0` on the flex/grid ancestors that contain scrollers.

Auto-follow new output only when the user is already near the bottom. When they scroll upward, keep their position stable and show a discreet return-to-latest control. Loading older messages must preserve the visible scroll anchor. Keep separate scroll positions for separate conversations.

During generation, show a quiet textual state such as “Working…” and a Stop action. Preserve the user's draft; do not block reading or selection of previous content. Announce complete status changes rather than every streamed token. Failed sends retain their content with an adjacent retry action.

## 7. Composer and usage notice

### 7.1 Messenger composer

**[Observed: S01]** The messenger composer is a roughly 44px-high gray pill aligned to the same 736px column as the messages. It contains an add/attachment control, a text field, a microphone control, and a circular send control. The placeholder is low-emphasis in the reference.

**[Recommended]** Use an actual labeled textarea even when it appears to be a single line. Grow to fit several lines, then scroll the text area internally. Keep the add and send actions vertically stable. Use an accessible placeholder color; a placeholder is not a substitute for an accessible field label.

### 7.2 Task composer

**[Observed: S03]** The task composer is about 98px high and has a large rounded rectangle shape. Input occupies its upper area. The bottom toolbar groups attachment and permission controls on the left, with model/effort selection, microphone, and send on the right.

Use approximately 12px side padding. Keep the bottom toolbar compact and on one baseline at desktop widths. Permission information is text plus an icon; orange is localized to the elevated-permission treatment. Model and effort values are text controls with a small chevron, not large badges.

**[Recommended]** Populate model names, effort options, usage state, and permissions from real capabilities. The labels visible in the screenshots are not a product API contract. Wrap toolbar groups deliberately on small widths; never overlap the send button or silently hide the permission state.

### 7.3 Quota/availability notice

**[Observed: S03]** A wide `#212121` notice sits about 8px above the task composer. It shares the column width, has about a 28px radius and 24px padding, and displays a strong short title, supporting text, and two right-aligned actions. Its screenshot height is about 108px.

Treat this as a layout variant, not permanent decoration. **[Recommended]** Render it only for a real usage or availability condition. Obtain reset times and entitlement-specific actions from application state; display timestamps in the user's locale/time zone. Do not invent a reset, upgrade, or billing capability.

At narrow widths, move the actions below the text. Keep the draft editable even when sending is unavailable unless the actual workflow requires otherwise. Explain why sending is blocked beside the relevant action. Never rely on a grayed-out arrow alone.

## 8. Settings screen templates

### 8.1 Shared settings scaffold

**[Observed: S05, S07, S08]** Settings occupy the main pane as a page, not a centered modal. The layout uses the same global rail, a settings-specific sidebar, and an approximately 728px-wide center column.

Place the 28px page heading about 76px below the main pane's top. Allow a single supporting line underneath when useful. Align heading actions to the right of this same column, not to the window's right edge. Major sections are separated by roughly 52px.

Do not give every setting its own heading. Use a short section label above a group, then individual row labels and descriptions inside it. Keep the content's left edge consistent across title, tabs, group headings, cards, and unboxed lists.

### 8.2 General settings: grouped rows

A settings group has a `#232323` fill, 1px subtle border, and 16px radius. Individual rows use approximately 16px horizontal and 12px vertical padding. Dividers are inset to the row content edges. [S05]

Rows contain a left text stack and a right control. Labels use approximately 13/18px text. Descriptions use approximately 12/16px text, start about 2px below the label, and wrap naturally. Rows are generally around 60px high but expand for multi-line descriptions; permission rows in S05 are taller.

Switches remain at the far right and align with the row's text block. A path and its Change action may share the control area. Ellipsize paths in the middle where practical, but expose the full value on focus or through a details/copy action. Do not truncate explanatory permission text.

Dropdown triggers use rounded rectangles, a restrained outline, current-value text, and a down chevron. They are about 28px high. Keep control widths based on their contents within sensible limits; avoid making every selector 240px wide.

### 8.3 Plugins: unboxed list

**[Observed: S07]** The page has a heading and description, a right-aligned secondary action and white primary Add button, then a horizontal control row with category tabs on the left and a compact search field on the right.

Plugin rows are on the main canvas, not inside a large settings card. Each row has a 40px icon container, a text stack with name and one-line description, and a switch at the far right. The row pitch is approximately 68px. Preserve the substantial empty area below a short list.

Tabs are compact text controls with a subtle filled background on the active tab; counts are muted inline text. Do not add a full-width underline or oversized segmented background. Search is about 224px wide in this reference; allow it to adapt rather than forcing that width on narrow screens.

**[Recommended]** Empty and filtered-empty results should be different: explain how to add the first integration in the former and offer to clear filters in the latter. A failed enable/disable action should retain the row and report the error near its switch.

### 8.4 Connections: controls plus device rows

**[Observed: S08]** Compact tabs sit below the page heading. A section header aligns with refresh and Add controls on the right. The first bordered group combines an allow-connections switch row with a device row, separated by an inset line.

The device row has a small outline icon, name, secondary connection metadata, and a trailing revoke action. A later section contains a separate one-row card with a label/description and a switch. Keep these as two groups rather than merging unrelated settings.

**[Recommended]** When revocation would disconnect a session or remove another device's access, explain the effect and obtain appropriate confirmation. During asynchronous actions, use a local pending state and prevent duplicate requests. Do not show success until the backend confirms it.

## 9. Menus, details panels, and transient surfaces

### 9.1 Agent-details panel

**[Observed: S02]** A panel approximately 300px wide is anchored near the upper-right controls. It overlays the conversation without narrowing or recentering the transcript, and there is no full-screen dimming scrim.

Its hierarchy is: avatar/name/activity; two equal-width actions; notification enablement; computers/devices; recent activity; and generated outputs. Use approximately 16px interior padding, muted section labels, and compact icon-led rows. Show unread indicators on the far right, without stealing text width unpredictably.

This is an anchored **nonmodal details popover**, not evidence of an always-open docked inspector. Its top-right position is relative to its trigger and viewport bounds, not fixed screenshot coordinates. Its height follows contents and becomes scrollable when needed.

**[Recommended]** Give it an accessible name. Escape and outside activation dismiss it; dismissal returns focus to the trigger when appropriate. Its mixed interactive content should not be given `role="menu"` merely because it floats. On small screens it may become a modal sheet with a close control and proper focus management.

### 9.2 Account menu

**[Observed: S04]** The account menu is approximately 230px wide, with an 18px outer radius. It opens near the account avatar at the bottom of the rail. A compact identity/plan header precedes a separator and action rows. Rows contain an outline icon, label, and optional right-aligned value, keyboard hint, or submenu chevron.

A highlighted row uses a slightly lighter rounded fill. Compact item heights are approximately 28–30px. Keyboard hints are secondary text, not large outlined keycaps.

**[Recommended]** Anchor to the avatar, prefer opening upward when space allows, and flip/shift to remain on-screen. Opening another transient menu closes the first. A submenu opens beside its parent where space allows and supports keyboard navigation. Use menu semantics for the action list, not for the identity text itself.

### 9.3 Multi-select menu

**[Observed: S06]** The trigger summarizes the selection count. The open surface is approximately 240px wide with about 28px item pitch. Labels align left, and checkmarks align right in a stable column. Some checked items have more muted labels than others.

Do **not** infer disabled state from muted color alone. Selection, availability, hover, and focus are independent. A selected-but-disabled option may retain its checkmark, but only mark it disabled when application state establishes that fact.

**[Recommended]** Use checkbox-menu or multi-select listbox semantics consistently. Space toggles the focused item; arrow keys navigate; Escape closes and restores trigger focus. Keep a multi-select menu open while selections change. Update the trigger count immediately after confirmed local selection. A single-select menu normally closes after a choice.

### 9.4 Tooltips, dialogs, and notifications

A compact tooltip with a label and shortcut is visible in S02. Exact delay and animation cannot be inferred. **[Recommended]** Use roughly a 500ms pointer delay, immediate keyboard-focus availability, and no layout shift. A tooltip must not be the only source of essential information.

Error dialogs, confirmation modals, and toasts are **extensions**, not reconstructed screenshot components. Reuse the same palette and typography. Use a scrim and focus containment for a true modal, not for an ordinary menu. Keep errors near the affected control; reserve global banners for genuinely global problems.

## 10. Primitive component contract

The following sizes are normalized implementation targets based on the visible density. They are not a claim about internal OpenAI component names.

| Primitive | Geometry / visual treatment | Required variants and states |
| --- | --- | --- |
| Icon button | 32px desktop target; 16–18px icon; 10px radius | Default, hover, focus-visible, pressed, disabled; accessible label |
| Rail destination | About 36px active plate in a 52px rail | Selected, unselected, unread; persistent selected state |
| Small button | 28–32px high; 12px horizontal padding; pill or 10px radius | Primary white, secondary gray, outline, pending, disabled |
| Search field | 36px high; 12px padding; pill shape | Empty, entered, focus, clearable, disabled |
| Switch | 32 × 20px visible track; 16px thumb | Off/on, pending, disabled; at least 32px-high desktop hit area |
| Menu item | 28–30px desktop row; about 8px horizontal padding | Hover, focus, checked, disabled, destructive, submenu |
| Settings row | 60px minimum; 12 × 16px padding | Plain, toggle, select, path/action, pending, error |
| Settings group | 16px corners; 1px border; inset dividers | Single-row and multi-row |
| Tab | About 28px high; 10px side padding | Active, inactive, focus-visible, disabled; optional inline count |
| Message bubble | 10 × 16px padding; max 88% column width | Assistant messenger, user messenger, user task |
| Composer | 44px messenger / 98px task baseline | Empty, populated, focused, streaming, blocked, attachment pending |
| Details popover | 300px wide; 16px padding | Open, loading sections, section error, bounded scroll |
| Account/select menu | 230px / 240px wide | Anchored, collision-adjusted, keyboard-controlled |
| Integration row | 40px logo; 12px gap; about 68px pitch | Enabled, disabled, pending, error, absent description |
| Quota notice | 24px padding; 28px radius; about 108px at reference content | Quota, temporary availability; responsive action wrap |

A disabled button is not simply an opacity-reduced ancestor: that can make all contained text unreadable. Style the control's unavailable state deliberately and provide an explanation when it matters. Do not make a visually disabled element remain click-active.

## 11. Interaction, keyboard, and state behavior

Everything in this section is **recommended implementation behavior** unless tied to a visible state elsewhere.

### 11.1 State styling

| State | Treatment |
| --- | --- |
| Rest | No decorative outline on passive content; controls use their semantic surface |
| Hover | One small local increase in surface brightness; no elevation jump or scale effect |
| Active/pressed | Brief local fill change; maintain label position |
| Selected | Persistent neutral fill or checked state; do not confuse with pointer hover |
| Focus-visible | 2px light-blue outline with 2px offset; do not remove without an equivalent |
| Disabled | No activation; muted appearance; preserve surrounding context and explanatory text |
| Pending | Local spinner or status label; stable dimensions; prevent duplicate submissions |
| Error | Explain the failure and recovery action locally; retain entered content |
| Empty | Short contextual statement with at most one useful primary action |
| Offline | Explicit connection text and a recoverable action; not just a dimmed icon |

Do not assume a visible gray bar in the computers panel is a loading skeleton; its meaning is not established. Build skeletons only for real loading states, with dimensions matching the final content.

### 11.2 Keyboard behavior

Use Tab/Shift+Tab through meaningful interactive elements. Menus support arrow navigation, Home/End, typeahead where suitable, and Escape. Tabs use arrow navigation within the tablist; expose selected state and associate each tab with its panel. Switches operate with Space. Follow a single established pattern for each widget rather than mixing menu/listbox/dialog behavior. [A4]

**Composer defaults:** Enter sends when sending is available; Shift+Enter inserts a newline. Do not send while an input-method editor is composing text. Make multiline and alternate-send behavior explicit in product settings where necessary. Do not use Enter to trigger a hidden destructive action.

**Application shortcuts:** `Cmd/Ctrl+N` for a new task and `Cmd+,` for settings are reasonable desktop recommendations, not verified Codex shortcuts. Only advertise shortcuts implemented by the host. Browser builds must not silently hijack reserved browser commands. Match shortcut glyphs to the operating system.

### 11.3 Motion

Use 120ms for hover and switch transitions, 180ms for menus, and up to 220ms for drawer transitions, with `cubic-bezier(0.2, 0, 0, 1)`. These values are recommendations; still screenshots cannot establish timing.

Animate opacity and small translations where needed. Avoid springy overshoot, bouncing controls, layout-wide crossfades, or a typing animation for text already received. Respect reduced motion and avoid attention-seeking perpetual shimmer.

### 11.4 Layering and focus

Use semantic layer tokens: base 0, sticky header/composer 10, popover 40, tooltip 50, modal 80, toast 90. Portals and CSS stacking contexts must be tested; a high number alone does not escape an ancestor's stacking context.

A nonmodal popover does not trap focus like a modal. A modal sheet/dialog does contain focus, makes background content inert, and restores focus to an appropriate trigger on dismissal. Nested overlays dismiss from the innermost layer outward.

## 12. Responsive and platform adaptation

**All breakpoints and narrow-layout behavior below are recommended. No mobile, light-mode, or narrow-window screenshot was supplied.**

| Available application width | Recommended shell behavior |
| --- | --- |
| 1200px and above | Full 52px rail + 290px sidebar; center-column max widths unchanged |
| 900–1199px | Retain rail; use a sidebar around 248px; reduce free margins, not body text |
| 600–899px | Keep the rail; move the contextual sidebar into an explicitly openable navigation drawer |
| Below 600px | Use a compact header and modal navigation drawer; hide the permanent rail; retain navigation access |

Use the **main pane's container width**, not only the viewport width, for settings-row wrapping. Around 640px of main-pane width, stack long selector/path controls below their labels. Simple switches can remain in a trailing column. At smaller widths, place page actions and search on subsequent rows rather than squeezing the heading.

Conversation columns become fluid with 24px minimum side gutters, then 16px on small screens. Messages may use up to 92% width on small screens. Preserve the difference between messenger and task modes; do not switch visual modes just because the window narrowed.

The composer grows vertically with its contents and avoids the software keyboard/safe area in mobile hosts. Keep menus within viewport bounds. Convert the details panel to a sheet only when the anchor/popover layout no longer fits.

On pointer-coarse interfaces, prefer 44px targets for controls and menu rows. On desktop, visual controls can remain compact while their non-overlapping interactive hit regions are larger. Hiding a sidebar in CSS is not a complete responsive implementation: a working, keyboard-accessible navigation opener and drawer must also exist.

**Light mode:** not specified. Do not invert dark colors mechanically or claim parity without a separate light-theme reference and contrast review. The delivered tokens target dark mode only.

## 13. Accessibility and readable density

The visual reference is a starting point, not an accessibility conformance certificate.

Use semantic landmarks for global navigation, contextual navigation, and main content. Distinguish their accessible labels. Provide one main page heading per settings view. Associate every setting's label and description with its control. A colored dot, icon, or switch position cannot be the only available state description.

For ordinary text, validate at least 4.5:1 contrast; for large text, 3:1 applies under WCAG's definition. Required control boundaries, state indicators, and meaningful non-text graphics generally require 3:1 against adjacent colors. Decorative separators need not be promoted to control outlines. [A1, A2]

WCAG 2.2's minimum target-size criterion uses 24 × 24 CSS pixels with specified exceptions, including spacing-based cases. This design recommends 32px or larger desktop hit areas where possible and 44px for touch; the visible 32 × 20px switch is not its entire hit target. [A3]

Keep essential descriptions readable in the accessible profile. Make keyboard focus apparent even on a selected row. Tooltips appear on focus as well as hover. Avoid hover-only actions with no keyboard route. Preserve readable layouts at 200% text zoom and test browser reflow at narrow effective widths.

Use live announcements for send failure, task completion, permission changes, and meaningful connection updates. Do not announce every token of a streamed answer. Mark background loading regions appropriately while leaving previously loaded content readable. Respect reduced motion and forced-colors mode.

For attachments, provide useful accessible names and preview descriptions. Distinguish a downloadable artifact from an image-viewer action. Do not expose private filesystem details in labels intended for shared/public screens.

## 14. Content and data-state rules

Use short sentence-case labels: “Default file open destination,” not “DEFAULT FILE OPEN DESTINATION.” Prefer a direct action name such as “Change” when the surrounding row supplies context. Keep descriptions explanatory and short; permissions deserve explicit consequences rather than vague reassurance.

Use real application state. A date separator is not a delivery timestamp; a read receipt is not a generic timestamp; a green presence dot is not a task-completed indicator. Keep these concepts separate in the data model.

**Recommended copy patterns:** loading—“Connecting…”; empty—“No devices connected”; recoverable failure—“Couldn't connect. Try again”; blocked action—“Sending is unavailable until …”. These are illustrative strings, not extracted product copy.

Format dates, times, plural counts, and numbers through locale-aware formatters. Do not hard-code English date layouts. Reserve enough room for translated controls and longer descriptions. Use logical CSS properties for layout, and validate mixed left-to-right technical strings inside right-to-left locales when supported.

Long project names truncate only in navigation. Full descriptions wrap. Filenames should preserve the extension when truncating, and paths should expose their full value through an accessible mechanism. Integration descriptions may wrap to two lines before increasing row height; they should not overlap switches.

Permission changes, connection revocations, and destructive actions need context-appropriate confirmation. Never interpret the screenshot's checked permission controls as authorization to enable elevated access in an implementation.

## 15. Implementation architecture

The names below are a suggested public component model, not recovered internal names.

```text
DesktopShell
├── TitlebarAdapter             Native titlebar or host application toolbar
├── GlobalRail
│   ├── RailDestination
│   └── AccountMenuTrigger
├── ContextSidebar
│   ├── WorkspaceNavigation     Projects, tasks, recents
│   └── SettingsNavigation      Heading, search, grouped destinations
└── MainPane
    ├── MessengerView
    │   ├── AgentHeader → AgentDetailsPopover
    │   ├── MessengerTranscript → MessageGroup → MessageBubble
    │   └── Composer(mode="messenger")
    ├── TaskView
    │   ├── TaskTranscript → TaskTurn → WorkSummary + TaskResponse
    │   ├── OptionalAvailabilityNotice
    │   └── Composer(mode="task")
    └── SettingsView
        ├── SettingsPageHeader
        ├── OptionalTabsAndSearch
        ├── SettingsSection → SettingsGroup → SettingsRow
        └── IntegrationList / DeviceGroup
```

Separate surface mode from message role. A recommended shape is:

```ts
type ConversationMode = "messenger" | "task";
type MessageRole = "user" | "assistant";
type SendState = "draft" | "sending" | "sent" | "failed";
type TaskState = "idle" | "running" | "completed" | "stopped" | "failed";
type ContrastProfile = "accessible" | "reference";
```

`mode` decides the template. `role` decides alignment within that template. Delivery/read state, task execution state, attachment state, and quota state should be separate fields—not inferred from a message's text or color.

Reuse `SettingsRow`, `MenuItem`, `IconButton`, `Switch`, `SearchField`, `Tabs`, `StatusDot`, and `Avatar`. Centralize tokens. Do not fork styles per page, hard-code screenshot coordinates into components, or introduce a dependency just to draw one icon.

Use established accessible interaction primitives or platform-native controls for menus, dialogs, tabs, and popovers. Keep product-specific styling in thin wrappers. The optional OpenAI Apps SDK UI can be a reference or component source, but this guide does not require it and does not assert that Codex desktop is built from it. [O1]

## 16. CSS foundation

The following stylesheet is also supplied as `codex-desktop.css`. It contains the tokens and representative layout/component classes, with the accessible contrast profile enabled by default.

It is a styling foundation, not a complete application: routing, data loading, menu anchoring/collision logic, focus management, drawers, keyboard handlers, and native window integration still belong in the implementation. Some specialized rows can be composed from these classes rather than having dedicated selectors.

Apply the theme to a shared ancestor of the app and all portal containers:

```html
<!-- Accessible contrast is the default; do not add reference mode in production. -->
<html lang="en" data-cdx-theme="dark">
  <body style="margin: 0">
    <div class="cdx-app" data-titlebar="custom">
      <!-- Titlebar, rail, sidebar, and main pane use the structure in Section 15. -->
    </div>
    <div id="overlays" class="cdx-overlay-root"></div>
  </body>
</html>
```

When the native host already supplies the titlebar outside the content viewport, use `data-titlebar="native"` and omit the duplicate custom toolbar. For reference screenshots only, set `data-cdx-contrast="reference"` on the same element as `data-cdx-theme`.

```css
/*
 * Codex Desktop — screenshot-derived design foundation, v1.0 (2026-10-02).
 * Not an official OpenAI stylesheet. See design.md for evidence and behavior.
 * Set data-cdx-theme="dark" on <html> or another shared ancestor of the app
 * and portal root. Accessible contrast is the default. Use
 * data-cdx-contrast="reference" only for screenshot-comparison fixtures.
 * This file provides tokens and visual primitives, not working UI behavior.
 */

[data-cdx-theme="dark"] {
  color-scheme: dark;

  /* Sampled surfaces. Chrome/menu approximations are discussed in design.md. */
  --cdx-bg-canvas: #181818;
  --cdx-bg-sidebar: #1e1e1e;
  --cdx-bg-chrome: #272728;
  --cdx-bg-card: #232323;
  --cdx-bg-banner: #212121;
  --cdx-bg-assistant-bubble: #2a2a2a;
  --cdx-bg-task-user: #2f2f2f;
  --cdx-bg-selected: #303030;
  --cdx-bg-search: #303030;
  --cdx-bg-composer: #363636;
  --cdx-bg-control: #2a2a2a;
  --cdx-bg-control-raised: #383838;
  --cdx-bg-popover: #2d2d2d;
  --cdx-bg-menu: #2c2c2c;
  --cdx-bg-menu-hover: #3d3d3d;
  --cdx-bg-user-bubble: #6e8eb5;

  /* Text tokens are practical approximations of rasterized text. */
  --cdx-text-primary: #ffffff;
  --cdx-text-secondary: #cdcdcd;
  --cdx-text-description: #a8a8a8;
  --cdx-text-muted: #929292;
  --cdx-text-sidebar-heading: #727272;
  --cdx-text-placeholder: #686868;
  --cdx-text-disabled: #727272;
  --cdx-text-on-primary: #181818;
  --cdx-text-on-user-bubble: #ffffff;

  --cdx-border-subtle: #353535;
  --cdx-border-control: #3c3c3c;
  --cdx-accent: #3a83f7;
  --cdx-status-online: #40c977;
  --cdx-avatar-green: #2ecc71;
  --cdx-avatar-lavender: #bac1d3;
  --cdx-warning: #e58b54; /* Recommended approximation, not an exact sample. */
  --cdx-danger: #ff8a8a; /* Recommended: no error screen was supplied. */
  --cdx-focus-ring: #a7c7ff; /* Recommended focus treatment. */
  --cdx-bg-backdrop: rgb(0 0 0 / 48%); /* Modal-only extension. */

  --cdx-font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --cdx-font-mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --cdx-type-caption: 0.75rem;
  --cdx-type-control: 0.8125rem;
  --cdx-type-body: 0.875rem;
  --cdx-type-sidebar-title: 1.125rem;
  --cdx-type-page-title: 1.75rem;
  --cdx-leading-caption: 1rem;
  --cdx-leading-control: 1.125rem;
  --cdx-leading-body: 1.25rem;
  --cdx-leading-prose: 1.375rem;

  --cdx-space-1: 4px;
  --cdx-space-2: 8px;
  --cdx-space-3: 12px;
  --cdx-space-4: 16px;
  --cdx-space-5: 20px;
  --cdx-space-6: 24px;
  --cdx-space-8: 32px;
  --cdx-space-10: 40px;
  --cdx-space-12: 48px;
  --cdx-space-14: 56px;

  --cdx-radius-control: 10px;
  --cdx-radius-card: 16px;
  --cdx-radius-menu: 18px;
  --cdx-radius-bubble: 22px;
  --cdx-radius-banner: 28px;
  --cdx-radius-pill: 999px;

  --cdx-titlebar-height: 44px;
  --cdx-rail-width: 52px;
  --cdx-sidebar-width: 290px;
  --cdx-conversation-width: 736px;
  --cdx-settings-width: 728px;
  --cdx-inspector-width: 300px;
  --cdx-content-gutter: 24px;
  --cdx-settings-top: 76px;
  --cdx-composer-bottom: 16px;
  --cdx-nav-row-height: 30px;
  --cdx-control-height: 28px;

  /* Motion, shadow, and layering are recommended implementation values. */
  --cdx-duration-fast: 120ms;
  --cdx-duration-standard: 180ms;
  --cdx-duration-panel: 220ms;
  --cdx-easing: cubic-bezier(0.2, 0, 0, 1);
  --cdx-shadow-popover: 0 12px 32px rgb(0 0 0 / 28%), 0 2px 8px rgb(0 0 0 / 18%);
  --cdx-z-base: 0;
  --cdx-z-sticky: 10;
  --cdx-z-popover: 40;
  --cdx-z-tooltip: 50;
  --cdx-z-modal: 80;
  --cdx-z-toast: 90;
}

/* Default production profile. Reference colors remain available above. */
[data-cdx-theme="dark"]:not([data-cdx-contrast="reference"]) {
  --cdx-text-muted: #a8a8a8;
  --cdx-text-sidebar-heading: #a8a8a8;
  --cdx-text-placeholder: #aaaaaa;
  --cdx-bg-user-bubble: #47698f;
  --cdx-border-control: #858585;
}

.cdx-app,
.cdx-app *,
.cdx-app *::before,
.cdx-app *::after,
.cdx-overlay-root,
.cdx-overlay-root *,
.cdx-overlay-root *::before,
.cdx-overlay-root *::after { box-sizing: border-box; }

.cdx-app,
.cdx-overlay-root {
  color: var(--cdx-text-primary);
  font-family: var(--cdx-font-ui);
  font-size: var(--cdx-type-body);
  line-height: var(--cdx-leading-body);
}

.cdx-app :where(button, input, textarea, select),
.cdx-overlay-root :where(button, input, textarea, select) {
  font: inherit;
  color: inherit;
}

.cdx-app :where(button, a, input, textarea, select, [tabindex]):focus-visible,
.cdx-overlay-root :where(button, a, input, textarea, select, [tabindex]):focus-visible {
  outline: 2px solid var(--cdx-focus-ring);
  outline-offset: 2px;
}

.cdx-app :where(button, input, textarea, select):disabled,
.cdx-overlay-root :where(button, input, textarea, select):disabled {
  cursor: not-allowed;
  color: var(--cdx-text-disabled);
}

.cdx-app {
  height: 100dvh;
  min-height: 0;
  display: grid;
  grid-template: "title title title" var(--cdx-titlebar-height)
                 "rail sidebar main" minmax(0, 1fr)
                 / var(--cdx-rail-width) var(--cdx-sidebar-width) minmax(0, 1fr);
  overflow: hidden;
  background: var(--cdx-bg-canvas);
}

.cdx-app[data-titlebar="native"] {
  grid-template: "rail sidebar main" minmax(0, 1fr)
                 / var(--cdx-rail-width) var(--cdx-sidebar-width) minmax(0, 1fr);
}
.cdx-app[data-titlebar="native"] > .cdx-titlebar { display: none; }

.cdx-titlebar {
  grid-area: title;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-inline: 12px;
  background: var(--cdx-bg-chrome);
}
.cdx-rail {
  grid-area: rail;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-block: 8px;
  background: var(--cdx-bg-chrome);
}
.cdx-rail__account { margin-block-start: auto; }
.cdx-sidebar {
  grid-area: sidebar;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--cdx-bg-sidebar);
  border-inline-end: 1px solid var(--cdx-border-subtle);
}
.cdx-sidebar__header { padding: 12px 16px 8px; }
.cdx-sidebar__title { margin: 0; font-size: var(--cdx-type-sidebar-title); line-height: 24px; font-weight: 600; }
.cdx-sidebar__scroll { flex: 1; min-height: 0; overflow: auto; padding: 0 8px 8px; }
.cdx-sidebar__section { margin: 20px 8px 8px; color: var(--cdx-text-sidebar-heading); font-size: var(--cdx-type-body); font-weight: 500; }
.cdx-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: var(--cdx-nav-row-height);
  margin-block: 1px;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--cdx-radius-control);
  background: transparent;
  color: var(--cdx-text-secondary);
  text-decoration: none;
  text-align: start;
  cursor: pointer;
}
.cdx-nav-item:hover { background: var(--cdx-bg-control); }
.cdx-nav-item[aria-current="page"] { background: var(--cdx-bg-selected); color: var(--cdx-text-primary); }
.cdx-nav-item[data-depth="1"] { padding-inline-start: 24px; }
.cdx-truncate { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cdx-nav-item__trailing { flex-shrink: 0; margin-inline-start: auto; color: var(--cdx-text-muted); font-size: var(--cdx-type-control); }
.cdx-status-dot { display: inline-block; width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; background: var(--cdx-accent); }
.cdx-status-dot[data-status="online"] { background: var(--cdx-status-online); }

.cdx-main { grid-area: main; min-width: 0; min-height: 0; container: cdx-main / inline-size; }
.cdx-settings-scroll { height: 100%; overflow: auto; }
.cdx-settings {
  width: calc(100% - var(--cdx-content-gutter) - var(--cdx-content-gutter));
  max-width: var(--cdx-settings-width);
  margin-inline: auto;
  padding-block: var(--cdx-settings-top) 64px;
}
.cdx-page-title { margin: 0; font-size: var(--cdx-type-page-title); line-height: 34px; font-weight: 600; letter-spacing: -0.025em; }
.cdx-page-description { margin: 4px 0 0; color: var(--cdx-text-description); }
.cdx-settings-section { margin-block-start: 52px; }
.cdx-settings-section__heading { margin: 0 0 16px; font-size: var(--cdx-type-body); line-height: 20px; font-weight: 500; }
.cdx-settings-group { overflow: hidden; border: 1px solid var(--cdx-border-subtle); border-radius: var(--cdx-radius-card); background: var(--cdx-bg-card); }
.cdx-settings-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 24px; min-height: 60px; padding: 12px 16px; }
.cdx-settings-row:not(:last-child)::after { position: absolute; inset-inline: 16px; bottom: 0; height: 1px; content: ""; background: var(--cdx-border-subtle); }
.cdx-settings-row__label { margin: 0; font-size: var(--cdx-type-control); line-height: var(--cdx-leading-control); font-weight: 400; }
.cdx-settings-row__description { margin: 2px 0 0; color: var(--cdx-text-description); font-size: var(--cdx-type-caption); line-height: var(--cdx-leading-caption); }
.cdx-settings-row__control { min-width: 0; justify-self: end; max-width: 280px; }

.cdx-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: var(--cdx-control-height); padding: 4px 12px; border: 1px solid transparent; border-radius: var(--cdx-radius-pill); background: var(--cdx-bg-selected); font-size: var(--cdx-type-control); line-height: var(--cdx-leading-control); white-space: nowrap; cursor: pointer; }
.cdx-button:hover:not(:disabled) { background: var(--cdx-bg-control-raised); }
.cdx-button[data-variant="primary"] { background: #ffffff; color: var(--cdx-text-on-primary); }
.cdx-button[data-variant="primary"]:hover:not(:disabled) { background: #e8e8e8; }
.cdx-button[data-variant="outline"] { border-color: var(--cdx-border-control); background: transparent; }
.cdx-button[data-variant="outline"]:hover:not(:disabled) { background: var(--cdx-bg-control); }
.cdx-button[data-shape="rounded"] { border-radius: var(--cdx-radius-control); }
.cdx-icon-button { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--cdx-radius-control); background: transparent; color: var(--cdx-text-muted); cursor: pointer; }
.cdx-icon-button:hover:not(:disabled) { background: var(--cdx-bg-control-raised); color: var(--cdx-text-primary); }
.cdx-icon { display: block; width: 16px; height: 16px; flex-shrink: 0; }
.cdx-icon-button .cdx-icon { width: 18px; height: 18px; }
.cdx-search { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 8px 12px; border: 1px solid var(--cdx-border-control); border-radius: var(--cdx-radius-pill); background: var(--cdx-bg-search); }
.cdx-search input { width: 100%; min-width: 0; padding: 0; border: 0; background: transparent; }
.cdx-search:focus-within { outline: 2px solid var(--cdx-focus-ring); outline-offset: 2px; }
.cdx-search input:focus-visible { outline: none; }
.cdx-search input::placeholder { color: var(--cdx-text-placeholder); opacity: 1; }

/* Use a labeled button[role=switch] or implement the equivalent with a checkbox. */
.cdx-switch { display: inline-flex; justify-content: center; align-items: center; width: 44px; height: 32px; padding: 0; border: 0; border-radius: 8px; background: transparent; cursor: pointer; }
.cdx-switch__track { display: block; width: 32px; height: 20px; padding: 2px; border-radius: 999px; background: var(--cdx-bg-control-raised); box-shadow: inset 0 0 0 1px var(--cdx-border-control); }
.cdx-switch__thumb { display: block; width: 16px; height: 16px; border-radius: 50%; background: #ffffff; transition: transform var(--cdx-duration-fast) var(--cdx-easing); }
.cdx-switch[aria-checked="true"] .cdx-switch__track { background: var(--cdx-accent); box-shadow: none; }
.cdx-switch[aria-checked="true"] .cdx-switch__thumb { transform: translateX(12px); }
.cdx-switch:disabled .cdx-switch__track { opacity: 0.5; }

.cdx-conversation { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: 100%; min-height: 0; }
.cdx-conversation__header { position: relative; z-index: var(--cdx-z-sticky); }
.cdx-transcript-scroll { min-height: 0; overflow: auto; overscroll-behavior: contain; }
.cdx-transcript,
.cdx-composer-dock { width: calc(100% - var(--cdx-content-gutter) - var(--cdx-content-gutter)); max-width: var(--cdx-conversation-width); margin-inline: auto; }
.cdx-transcript { padding-block: 24px; }
.cdx-message-group + .cdx-message-group { margin-block-start: 16px; }
.cdx-message-group > .cdx-message + .cdx-message { margin-block-start: 4px; }
.cdx-message { width: fit-content; max-width: 88%; padding: 10px 16px; border-radius: var(--cdx-radius-bubble); background: var(--cdx-bg-assistant-bubble); overflow-wrap: anywhere; }
.cdx-message[data-role="user"] { margin-inline-start: auto; background: var(--cdx-bg-user-bubble); color: var(--cdx-text-on-user-bubble); }
.cdx-message p { margin: 0; }
.cdx-message p + p { margin-block-start: 12px; }
.cdx-message a,
.cdx-task-response a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.cdx-message-meta { margin-block-start: 4px; color: var(--cdx-text-muted); font-size: var(--cdx-type-caption); line-height: 16px; }
.cdx-message-meta[data-align="end"] { text-align: end; padding-inline-end: 16px; }
.cdx-date-separator { margin-block: 28px 12px; color: var(--cdx-text-muted); font-size: var(--cdx-type-caption); text-align: center; }
.cdx-task-turn + .cdx-task-turn { margin-block-start: 48px; }
.cdx-task-prompt { width: fit-content; max-width: 88%; margin-inline-start: auto; padding: 12px 16px; border-radius: 18px; background: var(--cdx-bg-task-user); overflow-wrap: anywhere; }
.cdx-task-response { margin-block-start: 48px; line-height: var(--cdx-leading-prose); overflow-wrap: anywhere; }
.cdx-task-response__summary { display: flex; align-items: center; gap: 6px; width: 100%; padding: 0 0 8px; border: 0; border-bottom: 1px solid var(--cdx-border-subtle); background: transparent; color: var(--cdx-text-muted); text-align: start; }
.cdx-task-response__body p { margin: 16px 0 0; }
.cdx-task-response__actions { display: flex; align-items: center; gap: 4px; margin-block-start: 8px; color: var(--cdx-text-muted); }
.cdx-output-preview { display: block; width: min(332px, 100%); height: auto; margin-block-start: 24px; border: 1px solid var(--cdx-border-subtle); border-radius: 8px; }
.cdx-composer-dock { padding-block: 8px max(var(--cdx-composer-bottom), env(safe-area-inset-bottom)); }
.cdx-composer { border: 1px solid var(--cdx-border-control); border-radius: var(--cdx-radius-bubble); background: var(--cdx-bg-composer); }
.cdx-composer:focus-within { outline: 2px solid var(--cdx-focus-ring); outline-offset: 2px; }
.cdx-composer[data-mode="messenger"] { display: flex; align-items: center; gap: 4px; min-height: 44px; padding: 4px 6px; }
.cdx-composer[data-mode="task"] { min-height: 98px; padding: 10px 12px 6px; }
.cdx-composer textarea { display: block; flex: 1; width: 100%; min-width: 0; min-height: 20px; max-height: min(240px, 35dvh); margin: 0; padding: 0; resize: none; border: 0; background: transparent; line-height: 20px; }
.cdx-composer textarea:focus-visible { outline: none; }
.cdx-composer textarea::placeholder { color: var(--cdx-text-placeholder); opacity: 1; }
.cdx-composer[data-mode="task"] textarea { min-height: 44px; }
.cdx-composer__toolbar { display: flex; align-items: center; gap: 8px; margin-block-start: 4px; }
.cdx-composer__trailing { display: flex; align-items: center; gap: 8px; margin-inline-start: auto; }
.cdx-quota-banner { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 108px; margin-block-end: 8px; padding: 24px; border-radius: var(--cdx-radius-banner); background: var(--cdx-bg-banner); }
.cdx-quota-banner__title { margin: 0; font-size: var(--cdx-type-body); font-weight: 600; }
.cdx-quota-banner__description { margin: 4px 0 0; color: var(--cdx-text-secondary); }

/* Position these through an anchored overlay primitive, not fixed coordinates. */
.cdx-popover { width: min(var(--cdx-inspector-width), calc(100vw - 24px)); max-height: calc(100dvh - 72px); overflow: auto; padding: 16px; border: 1px solid var(--cdx-border-subtle); border-radius: var(--cdx-radius-menu); background: var(--cdx-bg-popover); box-shadow: var(--cdx-shadow-popover); z-index: var(--cdx-z-popover); }
.cdx-menu { width: 240px; max-width: calc(100vw - 24px); max-height: calc(100dvh - 24px); overflow: auto; padding: 4px; border: 1px solid var(--cdx-border-subtle); border-radius: var(--cdx-radius-menu); background: var(--cdx-bg-menu); box-shadow: var(--cdx-shadow-popover); z-index: var(--cdx-z-popover); }
.cdx-menu[data-menu="account"] { width: 230px; }
.cdx-menu-item { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 28px; padding: 4px 8px; border: 0; border-radius: 9px; background: transparent; text-align: start; font-size: var(--cdx-type-control); line-height: 20px; cursor: pointer; }
.cdx-menu-item:hover:not(:disabled),
.cdx-menu-item:focus-visible { background: var(--cdx-bg-menu-hover); }
.cdx-menu-item__trailing { margin-inline-start: auto; color: var(--cdx-text-muted); }
.cdx-tabs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.cdx-tab { min-height: 28px; padding: 4px 10px; border: 0; border-radius: 10px; background: transparent; color: var(--cdx-text-muted); font-size: var(--cdx-type-control); cursor: pointer; }
.cdx-tab[aria-selected="true"] { background: var(--cdx-bg-card); color: var(--cdx-text-primary); }
.cdx-plugin-row { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 12px; min-height: 68px; }
.cdx-plugin-row__logo { display: block; width: 40px; height: 40px; object-fit: contain; border-radius: 10px; }
.cdx-plugin-row__title { margin: 0; font-weight: 500; }
.cdx-plugin-row__description { margin: 4px 0 0; color: var(--cdx-text-muted); font-size: var(--cdx-type-control); }

@container cdx-main (max-width: 640px) {
  .cdx-settings { padding-block-start: 40px; }
  .cdx-settings-row:not([data-control="toggle"]) { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .cdx-settings-row:not([data-control="toggle"]) .cdx-settings-row__control { justify-self: start; max-width: 100%; }
  .cdx-quota-banner { align-items: start; flex-direction: column; gap: 12px; padding: 20px; }
  .cdx-composer__toolbar { flex-wrap: wrap; }
}

/* These adaptations are recommended; no narrow-window screenshots were supplied. */
@media (min-width: 900px) and (max-width: 1199px) {
  .cdx-app { --cdx-sidebar-width: 248px; }
}
@media (max-width: 899px) {
  .cdx-app { --cdx-sidebar-width: 0px; }
  .cdx-app > .cdx-sidebar { display: none; }
  /* The application must expose a navigation button and render an accessible
     modal navigation drawer. Hiding the sidebar alone is not a complete UI. */
}
@media (max-width: 599px) {
  .cdx-app { --cdx-rail-width: 0px; --cdx-content-gutter: 16px; --cdx-settings-top: 32px; }
  .cdx-app > .cdx-rail { display: none; }
  .cdx-app .cdx-icon-button { width: 44px; height: 44px; }
  .cdx-app .cdx-switch { width: 44px; height: 44px; }
  .cdx-menu-item { min-height: 44px; }
  .cdx-settings-row { gap: 12px; }
  .cdx-message { max-width: 92%; }
}
@media (prefers-reduced-motion: reduce) {
  .cdx-app *, .cdx-app *::before, .cdx-app *::after,
  .cdx-overlay-root *, .cdx-overlay-root *::before, .cdx-overlay-root *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}
@media (forced-colors: active) {
  .cdx-settings-group, .cdx-composer, .cdx-button, .cdx-menu, .cdx-popover,
  .cdx-switch__track, .cdx-search { border: 1px solid ButtonText; }
  .cdx-nav-item[aria-current="page"], .cdx-tab[aria-selected="true"] { outline: 2px solid Highlight; }
  .cdx-switch[aria-checked="true"] .cdx-switch__track { background: Highlight; }
}
```

## 17. Build order and acceptance criteria

### 17.1 Build order

First implement the shell and verify its columns. Next implement the contextual sidebar and common controls. Then build the settings scaffold and its three reference variants. Add messenger and task templates as distinct routes/modes. Finally implement anchored overlays, keyboard behavior, responsive navigation, asynchronous states, and accessibility review.

Do not spend the first iteration matching a single icon while the sidebar is 40px too wide or the main column is centered on the wrong region.

### 17.2 Visual acceptance

At a desktop fixture around 1400 × 1000px, compare the implementation to each reference after excluding native framing and unrelated outside pixels. Exact font rendering varies by platform, so prioritize geometry and solid surfaces before antialiasing.

- [ ] The global rail is about 52px and the contextual sidebar about 290px; neither grows with the window by default.
- [ ] The main canvas is `#181818`; the sidebar, settings groups, bubbles, composer, and overlays remain distinguishable.
- [ ] Settings content is about 728px wide; conversation content and composer share a 736px maximum.
- [ ] Content is centered in the main pane, with a settings heading starting about 76px below its top.
- [ ] Navigation remains compact, selected rows have about 8px outer gutters, and trailing dots do not force labels into them.
- [ ] Messenger uses assistant bubbles and blue user bubbles; task mode uses neutral user prompts and transparent assistant output.
- [ ] The quota notice is conditional, follows actual state, and sits above rather than inside the composer.
- [ ] Settings use grouped rows with inset separators; plugin rows stay unboxed.
- [ ] The agent panel overlays rather than resizes the conversation, and ordinary menus have no modal scrim.
- [ ] Typography remains compact: body around 14px, controls around 13px, descriptions around 12px, page headings around 28px.
- [ ] Large empty areas remain empty; no unrequested charts, gradients, hero headings, cards, or terminal panels have been added.

Suggested visual-diff tolerances for the same environment are ±2px for small primitives and ±4px for major alignment landmarks. These are review targets, not proof of exact original CSS values. Compare the reference profile to screenshots; evaluate the accessible profile separately for intentional color changes.

### 17.3 Behavior and resilience acceptance

- [ ] Every visible button performs a real action or has an explicit disabled state; no decorative fake window controls exist.
- [ ] Menus work with keyboard, Escape, outside activation, typeahead where appropriate, and focus restoration.
- [ ] Switches expose checked state and a programmatic label, and asynchronous failures do not silently leave incorrect state visible.
- [ ] Composer drafts survive failed sends, route changes where appropriate, and temporary usage restrictions.
- [ ] Streaming does not yank the viewport away from older content the user is reading.
- [ ] Long project names, multi-line settings descriptions, empty lists, loading, offline, and error states remain usable.
- [ ] The app works at 1440, 1200, 1024, 768, and approximately 390px widths with accessible navigation at every size.
- [ ] Text zoom, focus-visible, reduced motion, contrast, and forced-colors behavior are checked manually as well as automatically.
- [ ] Popovers stay within the viewport, do not clip against scroll containers, and remain readable above the composer.
- [ ] Screenshot identity, device, repository, model, billing, and permission values are not hard-coded into production logic.

### 17.4 What remains unverified by the references

The screenshots do not establish the original font file, CSS framework, native UI framework, exact blur/shadow values, hover timing, keyboard shortcuts, responsive breakpoints, light mode, animations, loading/error screens, model capabilities, entitlement rules, or the contents of settings pages not shown.

This specification supplies labeled recommendations for those areas where needed. It should be validated against a running implementation and any additional references rather than promoted to an official Codex source document.

## 18. Evidence and source notes

### 18.1 Measurement checkpoints

Coordinates below are `(x, y)` pixels from the top-left of the original supplied PNG, or explicitly noted edge ranges. They are useful for reproducing the analysis; do not use them as absolute layout coordinates in an application.

| Reference | Checkpoint | Result |
| --- | --- | --- |
| S01 | Main empty region approximately x360–479, y510–939 | Flat `#181818` canvas |
| S01 | Assistant bubble interior around x530–1129, y180–229 | Dominant flat fill `#2A2A2A`, excluding text |
| S01 | User bubble interior around x950–1219, y310–329 | Dominant fill `#6E8EB5` |
| S01 | Composer interior around x525–1229, y970–994 | Dominant fill `#363636` |
| S01 | Composer edges approximately x508–1244 | About 736px width |
| S02 | Details-panel blank region x1120–1384, y250–276 | Dominant fill `#2D2D2D` |
| S02 | Details-panel side edges approximately x1102–1402 | About 300px width |
| S03 | Task prompt interior around x1060–1229, y90–109 | Dominant fill `#2F2F2F` |
| S03 | Notice interior around x540–1009, y800–879 | Dominant fill `#212121` |
| S03 | Composer bounds approximately x516–1252, y903–1001 | About 736 × 98px |
| S05 | Group divider x540–1209 at y579 | `#353535` |
| S05 | Enabled switch around x1195–1226, y721–740 | Blue track `#3A83F7` and white thumb |
| S05 | Main-pane left edge near x351; card edges near x516 and x1244 | Main-pane-centered group about 728px wide |
| S06 | Select-menu edges near x519 and x759 | About 240px wide |
| S07 | Main-pane left edge near x349; content near x514–1242 | About 728px content width |
| S08 | Main-pane left edge near x354; group near x519–1247 | About 728px content width |

### 18.2 Public references

Public references were checked on 2026-10-02. Their scope is recorded to avoid implying that a screenshot measurement came from official source code.

**O1 — OpenAI Apps SDK UI repository.** Public token/component foundations for apps inside ChatGPT; not the desktop client's source.
`https://github.com/openai/apps-sdk-ui`

**O2 — OpenAI UI guidelines.** Public guidance for optional plugin UI in ChatGPT; supports the general visual principles, not desktop-specific measurements.
`https://developers.openai.com/plugins/concepts/ui-guidelines`

**A1 — W3C, Understanding SC 1.4.3: Contrast (Minimum).** Source for text-contrast requirements.
`https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html`

**A2 — W3C, Understanding SC 1.4.11: Non-text Contrast.** Source for required control/state contrast.
`https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html`

**A3 — W3C, Understanding SC 2.5.8: Target Size (Minimum).** Source for the 24px criterion and its exceptions.
`https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html`

**A4 — W3C WAI-ARIA Authoring Practices, Patterns.** Reference for appropriate menu, tab, dialog, listbox, and switch interaction patterns.
`https://www.w3.org/WAI/ARIA/apg/patterns/`

---

**Handoff summary:** Build a neutral, compact desktop shell with a 52px rail, 290px contextual sidebar, and main-pane-centered reading column. Preserve the distinction between messenger bubbles and task prose, between settings groups and unboxed integration rows, and between an anchored popover and a docked panel. Use semantic tokens, accessible interaction primitives, real application state, and restrained styling throughout.
