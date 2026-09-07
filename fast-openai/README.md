# Fast mode

Fast mode defaults to on for GPT-5.4, GPT-5.5, GPT-5.6 Luna, GPT-5.6 Sol,
and GPT-5.6 Terra. GPT-6 Astra defaults to off and supports explicit opt-in.
The extension applies only to the `openai-codex` provider using ChatGPT OAuth.

- `/fast on` enables Fast for the current model selection.
- `/fast off` disables Fast for the current model selection.
- `/fast status` reports the model default, manual override, and request eligibility.

Every model selection and session start restores the model's default. An override
applies only within that Pi instance, so enabling Fast on Astra does not enable it
in another session. The footer shows Fast only when the current model is eligible.

Eligible requests without an explicit `service_tier` receive `priority`. Existing
request tiers are preserved. Pi's displayed costs may undercount Fast usage because
the extension injects the tier after native pricing options are resolved.
