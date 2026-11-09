---
name: Open Dialer v2
description: A dense, calm operating workspace for responsible outbound calling.
colors:
  canvas: "#111110"
  sidebar: "#151513"
  surface: "#1c1c1a"
  surface-raised: "#20201e"
  input: "#181817"
  border: "#30302d"
  text: "#f3f2ed"
  text-muted: "#aaa9a2"
  accent: "#4a0d72"
  accent-hover: "#5c0f8d"
  accent-text: "#e4c8ff"
  accent-subtle: "#251436"
  accent-border: "#3b2573"
  link: "#cda4ff"
  danger: "#f1aaa0"
typography:
  page:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "32px"
    fontWeight: 750
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "20px"
    fontWeight: 750
    lineHeight: 1.2
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  meta:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.2
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "10px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "0.06em"
rounded:
  control: "8px"
  surface: "12px"
  pill: "999px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "24px"
  6: "32px"
  7: "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
    typography: "{typography.meta}"
    rounded: "{rounded.control}"
    padding: "0 {spacing.4}"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.meta}"
    rounded: "{rounded.control}"
    padding: "0 {spacing.3}"
    height: "40px"
  input:
    backgroundColor: "{colors.input}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 {spacing.3}"
    height: "40px"
---

# Design System: Open Dialer v2

## Overview

**Creative North Star: "The focused switchboard."**

Open Dialer v2 is an Operate-mode product: dense enough to work from all day, quiet enough that a caller can scan the next decision without visual noise. Dark neutral layers do the structural work; one aubergine accent communicates selection and forward action.

It uses one sans-serif family. Hierarchy comes from the approved type scale, weight, and space—not extra fonts or near-duplicate sizes.

**Key Characteristics:**

- Compact, high-contrast operational surfaces with meaningful dividers.
- One purposeful accent color; status is always named as well as colored.
- A stable control vocabulary so a familiar action looks familiar on every screen.

## Colors

The palette is intentionally narrow: neutral layers establish hierarchy, and aubergine communicates action.

### Primary

- **Aubergine action:** `accent`, `accent-hover`, and `accent-text` are the only primary-action colors. Use them for the primary button, selected navigation, conversion, and keyboard focus.

### Neutral

- **Night canvas:** `canvas` is the application backdrop; `sidebar` is a quiet navigation plane.
- **Layered work surface:** `surface`, `surface-raised`, and `input` separate grouped work without decorative shadows.
- **Readable ink:** `text`, `text-muted`, and `border` are the general content, helper, and rule colors.

### Feedback

- **Named warning:** `danger` is reserved for destructive or failed states. Do not use the accent color for errors.

**The One Accent Rule.** Do not introduce blue, green, or a second purple for a normal action. If a state needs semantic meaning, pair its limited color with explicit text.

## Typography

Use the one `Inter` system stack in `src/design-system.css`. The approved text sizes are exactly **10, 12, 14, 20, and 32px**. Icons may use their own optical sizes; they are not a second type scale.

- `label` (10px): uppercase table headers, compact section labels, and navigation grouping.
- `meta` (12px): buttons, supporting data, compact controls, and secondary navigation.
- `body` (14px): forms, list content, descriptions, and default copy.
- `title` (20px): card, panel, and brand titles.
- `page` (32px): page headings only.

**The Five-Step Type Rule.** No 11px, 13px, 15px, 17px, or 18px text in new interface work. Choose the nearest approved role before adding a local override.

## Layout

The application uses an anchored left navigation rail and a fluid workbench. Desktop work is compact; at 820px and below, controls gain a 44px minimum height and action groups may scroll rather than collapse their labels.

Use 4px only inside a tight component, 8–16px inside a control group, 24–32px between related regions, and 48px between major page sections.

**The Grouping Rule.** Space within a related group is always smaller than space between groups. Do not solve hierarchy with random margins.

## Elevation & Depth

The workspace is tonal, not card-heavy. Standard surfaces use a border and adjacent tonal contrast. Only protected overlays such as dialogs use the single dialog shadow (`0 18px 50px rgb(0 0 0 / 28%)`).

## Shapes

Controls have gently rounded 8px corners; panels use 12px corners; pills are only for compact status, tags, or segmented controls. Do not invent a new radius for a new screen.

## Components

All controls must map to one of these roles before new CSS is written:

| Role | Existing classes | Use |
| --- | --- | --- |
| Primary | `primary-button`, `call-button`, `convert-button` | One forward action per context. |
| Secondary | `quiet-button`, `outline-button`, `calls-outline-button`, `toolbar-button`, `quick-tour-button` | A visible alternative or grouped utility. |
| Ghost / text | Inline row actions and pagination actions | Low-emphasis actions where the surrounding row supplies the boundary. |
| Icon-only | `icon-button`, `close-button` | A familiar action with an accessible label. |
| Destructive | Secondary shape plus `danger` text | Irreversible actions only; never make it the default primary action. |

Inputs share the same 40px control height, 8px radius, border, placeholder, and focus ring. Tables use label headers, 14px primary content, and 12px supporting copy. Status chips are descriptive text first and color second.

**The Variant Rule.** New screens may compose existing roles but may not create a new button look, input radius, color, or font size without first updating this document and `src/design-system.css`.

## Do's and Don'ts

Do:

- Use `src/design-system.css` variables for all new color, type, spacing, radius, and focus decisions.
- Reuse an existing action role before adding a class name.
- Keep focus visible, labels explicit, and disabled states legible.

Don't:

- Add gradients, green accents, white-on-white controls, or decorative glow.
- Use raw hex values or one-off pixel values in a new screen when a system token exists.
- Change persisted keys, database table names, or environment variable names merely to change visible branding.
