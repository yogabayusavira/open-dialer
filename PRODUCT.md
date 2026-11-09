# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Inferred after the interactive stack-choice control was unavailable: React, TypeScript, Vite, and a minimal Node service. This keeps the operator interface fast while ensuring provider credentials never need to enter browser code. Docker is the intended Dokploy delivery format.

## Users

Independent sales operators and small outbound teams who need to work a lead list, make compliant calls, and leave each interaction with a clear next step.

## Product Purpose

Callboard is an original cold-calling workspace. It brings lead intake, a focused calling queue, outcomes, notes, and follow-ups into one deliberate workflow so a caller can move from preparation to the next action without losing context.

## Positioning

The product treats a calling session as a traceable work queue rather than a volume-dialing machine: every attempt has a reason, an outcome, a follow-up, and a compliance record.

## Operating Context

Users connect a Twilio account by entering an Account SID and Auth Token on a server-backed onboarding flow, then select an existing voice-capable number. They import or add leads, work them one at a time, capture dispositions and notes, and return to due follow-ups. Deployment will be to Dokploy after implementation is complete.

## Capabilities and Constraints

- Secure telephony onboarding validates an Account SID/Auth Token server-side; tokens are never returned to the browser or logged.
- The selected calling number must be an existing voice-capable Twilio number; purchasing numbers is out of scope.
- Manual lead creation, lead stages, and do-not-call suppression are implemented. CSV import, call outcomes, editable notes, and follow-up scheduling are deliberate next slices, not represented as live controls in this build.
- Do-not-call suppression, local calling-window checks, and audit events are MVP requirements.
- Automatic/predictive dialing, recordings, transcription, SMS, AI coaching, billing, and analytics beyond the work queue are deliberately deferred.
- Real outbound calling remains disabled until production voice webhooks and the required Twilio Voice configuration are supplied.

## Evidence on Hand

The workflow is based on the user's observed telephony sign-in and number-selection flow plus public product research. There are no approved brand assets, customer claims, testimonials, or performance statistics; the UI must use clearly synthetic demo data and make no invented claims.

## Product Principles

- Protect sensitive credentials by design, not by warning copy.
- Make the next responsible action obvious.
- Preserve caller context at the moment of disposition.
- Make compliance constraints visible before a call, not after it.
- Keep the first release small enough to operate and deploy confidently.

## Accessibility & Inclusion

Keyboard navigation, visible focus, semantic labels, reduced-motion support, and color-independent status cues are required.
