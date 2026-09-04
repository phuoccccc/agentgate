import json
import re

import pytest


CONTRACT_PATH = "contracts/agent_gate.py"


SCENARIOS = [
    pytest.param(
        "Send $5 to a known wallet.",
        "Recipient has received payments from this wallet multiple times.",
        "Normal small payments to known recipients are allowed.",
        "ALLOW",
        "LOW",
        "The small payment goes to a known recipient and follows the stated policy.",
        id="small-payment-to-known-wallet",
    ),
    pytest.param(
        "Send $10,000 to a new wallet.",
        "The wallet has never interacted with this recipient.",
        "Large transfers to unknown recipients should be blocked.",
        "BLOCK",
        "HIGH",
        "A large irreversible transfer to an unknown recipient conflicts with the policy.",
        id="large-transfer-to-new-wallet",
    ),
    pytest.param(
        "Read public market data.",
        "The agent is only retrieving public information.",
        "Read-only public actions are allowed.",
        "ALLOW",
        "LOW",
        "Reading public information is non-destructive and explicitly allowed.",
        id="read-public-market-data",
    ),
    pytest.param(
        "Delete the user's stored project data.",
        "This action cannot easily be reversed.",
        "Destructive actions require explicit user confirmation.",
        "BLOCK",
        "HIGH",
        "Irreversible deletion requires confirmation that is not present in the context.",
        id="delete-project-data",
    ),
    pytest.param(
        "Publish a draft project report to the team's shared workspace.",
        "The report is preliminary and the workspace may include external guests.",
        "Internal drafts may be shared with project members, but external sharing requires confirmation.",
        "BLOCK",
        "MEDIUM",
        "The uncertain audience makes confirmation prudent before sharing a preliminary report.",
        id="ambiguous-shared-workspace",
    ),
]


def _mock_evaluation(direct_vm, action, decision, risk, reason):
    """Return controlled LLM output when the prompt contains this exact action."""
    direct_vm.mock_llm(
        re.escape(action),
        json.dumps({"decision": decision, "risk": risk, "reason": reason}),
    )


@pytest.mark.parametrize(
    "action,context,policy,expected_decision,expected_risk,reason",
    SCENARIOS,
)
def test_agent_gate_scenarios(
    direct_vm,
    direct_deploy,
    action,
    context,
    policy,
    expected_decision,
    expected_risk,
    reason,
):
    """Deploy the contract, pass all inputs, and verify its structured result."""
    contract = direct_deploy(CONTRACT_PATH)
    _mock_evaluation(
        direct_vm, action, expected_decision, expected_risk, reason
    )

    contract.evaluate_action(action, context, policy)
    result = contract.get_last_evaluation()

    assert set(result) == {"decision", "risk", "reason"}
    assert result["decision"] == expected_decision
    assert result["decision"] in {"ALLOW", "BLOCK"}
    assert result["risk"] == expected_risk
    assert result["risk"] in {"LOW", "MEDIUM", "HIGH"}
    assert result["reason"] == reason
    assert isinstance(result["reason"], str)
    assert 1 <= len(result["reason"].strip()) <= 240


@pytest.mark.parametrize(
    "bad_result",
    [
        pytest.param(
            {"decision": "REVIEW", "risk": "MEDIUM", "reason": "Unknown decision."},
            id="invalid-decision",
        ),
        pytest.param(
            {"decision": "BLOCK", "risk": "CRITICAL", "reason": "Unknown risk."},
            id="invalid-risk",
        ),
        pytest.param(
            {"decision": "BLOCK", "risk": "HIGH", "reason": ""},
            id="empty-reason",
        ),
    ],
)
def test_invalid_ai_output_is_rejected(direct_vm, direct_deploy, bad_result):
    """Malformed AI output must not become an AgentGate evaluation."""
    contract = direct_deploy(CONTRACT_PATH)
    direct_vm.mock_llm(r"Evaluate the proposed action", json.dumps(bad_result))

    with direct_vm.expect_revert("invalid evaluation format"):
        contract.evaluate_action("Test action", "Test context", "Test policy")


def test_validator_agrees_with_matching_judgment(direct_vm, direct_deploy):
    """A validator accepts matching decision and risk fields."""
    contract = direct_deploy(CONTRACT_PATH)
    action = "Approve a routine internal status update."
    reason = "The update is routine, internal, and consistent with policy."
    _mock_evaluation(direct_vm, action, "ALLOW", "LOW", reason)
    contract.evaluate_action(action, "No sensitive data is included.", "Routine internal updates are allowed.")

    direct_vm.clear_mocks()
    _mock_evaluation(
        direct_vm,
        action,
        "ALLOW",
        "LOW",
        "The wording differs, but the independent judgment reaches the same result.",
    )

    assert direct_vm.run_validator() is True


def test_validator_rejects_conflicting_judgment(direct_vm, direct_deploy):
    """A validator rejects a leader when the stable judgment fields disagree."""
    contract = direct_deploy(CONTRACT_PATH)
    action = "Share account details with a new support contact."
    _mock_evaluation(
        direct_vm,
        action,
        "BLOCK",
        "HIGH",
        "Sensitive details should not be shared with an unverified contact.",
    )
    contract.evaluate_action(action, "The contact is not verified.", "Protect sensitive account data.")

    direct_vm.clear_mocks()
    _mock_evaluation(
        direct_vm,
        action,
        "ALLOW",
        "LOW",
        "The independent validator reached a conflicting judgment.",
    )

    assert direct_vm.run_validator() is False
