# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

import json
import genlayer as gl
from genlayer.types import *


class AgentGate(gl.contract.Contract):
    decision: str
    risk: str
    reason: str

    def __init__(self):
        self.decision = ""
        self.risk = ""
        self.reason = ""

    @gl.public.write
    def evaluate_action(
        self,
        action: str,
        context: str,
        policy: str,
    ) -> None:

        prompt = f"""
You are a trust and safety reviewer for an autonomous AI agent.

Your job is to decide whether the proposed action should be allowed or blocked.

Evaluate the action using the full context and policy.

ACTION:
{action}

CONTEXT:
{context}

POLICY:
{policy}

Return ONLY valid JSON in exactly this format:

{{
  "decision": "ALLOW",
  "risk": "LOW",
  "reason": "Short explanation"
}}

Rules:

1. decision must be either "ALLOW" or "BLOCK".
2. risk must be either "LOW", "MEDIUM", or "HIGH".
3. reason must briefly explain the judgment.
4. Consider the complete meaning of the action, context, and policy.
5. Do not make the decision using simple keyword matching alone.
6. Do not output markdown.
7. Output JSON only.
"""

        def get_evaluation() -> str:
            result = gl.nondet.exec_prompt(prompt)

            result = result.replace("```json", "")
            result = result.replace("```", "")

            return result.strip()

        criteria = """
Compare the proposed evaluation with your own independent evaluation.

The evaluations are equivalent only when:

1. They reach the same ALLOW or BLOCK decision.
2. They assign the same overall risk level: LOW, MEDIUM, or HIGH.
3. The reasoning is compatible with the supplied action, context, and policy.

Minor differences in wording of the reason are acceptable.

The decision and risk level must match.
"""

        result = gl.eq_principle.prompt_comparative(
            get_evaluation,
            criteria,
        )

        parsed = json.loads(result)

        decision = parsed["decision"]
        risk = parsed["risk"]
        reason = parsed["reason"]

        assert decision in ("ALLOW", "BLOCK")
        assert risk in ("LOW", "MEDIUM", "HIGH")
        assert isinstance(reason, str)
        assert len(reason.strip()) > 0

        self.decision = decision
        self.risk = risk
        self.reason = reason

    @gl.public.view
    def get_decision(self) -> str:
        return self.decision

    @gl.public.view
    def get_risk(self) -> str:
        return self.risk

    @gl.public.view
    def get_reason(self) -> str:
        return self.reason