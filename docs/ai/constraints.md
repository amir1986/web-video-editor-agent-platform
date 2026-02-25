## AI Constraints

1. All AI responses must be strict JSON only
2. AI responses must conform to the EditPlan schema
3. AI must not include any markdown, commentary, or explanations
4. AI must use low temperature (0.2) for deterministic responses
5. AI must retry up to 2 times on invalid JSON/schema failures
