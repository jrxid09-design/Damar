# 20 Rationalization register

No source-changing merge/removal was proven safe. src/tools_old is a DEPRECATION_CANDIDATE because callers and historical compatibility are not fully disproven. Provider implementations remain distinct because readiness and failure semantics differ.

Counterfactual rule: if behavior loss is YES or UNKNOWN, do not remove. Each canonical record now has exactly one final disposition; REWIRE is recorded separately as a migration action. Machine register: data/l11_rationalization_register.json.
