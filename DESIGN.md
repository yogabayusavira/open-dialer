---
name: Callboard
description: A focused route board for responsible calling work.
colors:
  ink: "#122018"
  text: "#17251e"
  paper: "#f4f1e8"
  surface: "#faf8f1"
  recessed: "#e8e5d9"
  divider: "#c8c8ba"
  muted: "#607568"
  lime: "#d9f99d"
  selected: "#e6f5c7"
  good: "#e3f5bf"
  alert: "#fde4db"
  alert-ink: "#8e3529"
  focus: "#b7ed64"
typography:
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "35px"
    lineHeight: 1.05
    letterSpacing: "-0.045em"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 800
    letterSpacing: "0.12em"
rounded:
  input: "7px"
  control: "9px"
  dialog: "12px"
  pill: "99px"
spacing:
  small: "8px"
  control-gap: "10px"
  panel: "28px"
  workbench: "46px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "43px"
  button-primary-hover:
    backgroundColor: "#244333"
  status-quiet:
    backgroundColor: "#e8e8df"
    textColor: "#536158"
    rounded: "{rounded.pill}"
    padding: "5px 9px"
---

# Design System: Callboard

## Overview

**Creative North Star: "The route board"**

A practical working interface organized around the next call. Warm paper surfaces, dark forest navigation, fine rules, and a restrained lime selection make the current stop easy to find while guardrails remain alongside it.

**Key Characteristics:**
- Dense, legible work areas with clear labels and dividers.
- Flat tonal panels and compact controls, with depth reserved for overlays.
- Status and compliance information expressed in words as well as color.

## Colors

Dark forest `#122018` anchors the sidebar and primary actions; `#17251e` is the default text. Warm paper `#f4f1e8`, surface `#faf8f1`, recessed `#e8e5d9`, and divider `#c8c8ba` form the workspace. Muted green `#607568` supports secondary text. Lime `#d9f99d` marks active navigation and small identity accents; pale green `#e6f5c7` marks the selected queue item. Status pills use quiet gray, good green, or alert coral with text labels. The focus outline is `#b7ed64`.

## Typography

The interface uses Inter when available, followed by system sans-serif fallbacks. The page title is 35px with tight tracking and a 1.05 line height; the selected lead name is 33px. Compact 11px, bold, tracked uppercase labels mark dates, panel kickers, and facts. Body and control text generally ranges from 12–16px. The call objective uses 16px / 1.55 and a maximum width of 56 characters.

## Layout

A 240px sidebar sits beside a centered workbench capped at 1640px, with 46px horizontal padding. The queue is a bordered three-column board: lead list, current call panel, and guardrails. Dividers and 20–31px panel padding establish rhythm; controls typically use 8–10px gaps. Other views use rows, a two-column settings grid, or a narrow activity list.

At 1120px and below, workbench padding becomes 28px and guardrails move beneath the two queue columns. At 820px and below, the sidebar becomes a sticky header with horizontally scrolling navigation, the queue stacks, and the lead list scrolls horizontally; settings, facts, and guardrails become one column. The table hides some fields and rearranges into two columns. At 490px and below, the add action becomes icon-only, call actions stack, and another table field is hidden. The body has a 320px minimum width.

## Elevation & Depth

The workspace is mostly flat, separated by borders and tonal changes. The sign-in card and lead dialog use `0 18px 50px` shadows; the dialog sits on a dark translucent backdrop.

## Shapes

Controls use 9px corners, inputs 7px, and dialogs 12px. Statuses are fully rounded pills; the brand mark and activity marks are circles. Tables and work panels rely primarily on square edges and fine borders.

## Components

- **Navigation:** icon and text rows with a lime active background; a count badge appears where applicable. The compact header preserves horizontal scrolling.
- **Buttons:** dark filled primary and call actions; pale bordered quiet and outline actions. Primary hover changes to `#244333`. Disabled controls use 0.55 opacity and a not-allowed cursor.
- **Queue:** selectable lead rows pair time, name, company, and chevron. Selection uses a pale green fill and dark left rule, which becomes a bottom rule on small screens. The current stop places facts, objective, call action, and compliance note together.
- **Status and feedback:** uppercase pills pair tone with a label; notices use an icon and text. Forms have visible labels, inline errors, and busy states. Empty settings show a centered explanatory panel.
- **Inputs and dialogs:** inputs are 43px high with light backgrounds and borders. The add-lead form is a scrollable, labelled modal; the sign-in card uses the same compact form language.
- **Accessibility:** buttons and inputs have a 3px lime `:focus-visible` outline with 3px offset. Icon-only controls have accessible labels, the lead dialog has dialog semantics, and notices/errors use status or alert roles where implemented. Loading spinners stop animating when the user prefers reduced motion.

## Do's and Don'ts

- Do keep the current lead, next action, and calling constraints together.
- Do pair status color with explicit text.
- Do preserve visible keyboard focus and labelled controls.
- Don't present deferred calling, import, or follow-up capabilities as already available.

