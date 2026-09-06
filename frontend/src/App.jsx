import { useRef, useState } from "react";
import { evaluateWithGenLayer } from "./genlayer.js";

const INITIAL_INPUTS = {
  action: "Send $10,000 to a new wallet.",
  context: "The wallet has never interacted with this recipient.",
  policy: "Large transfers to unknown recipients should be blocked.",
};

function getErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    if (typeof error.message === "string") return error.message;
    if (typeof error.details === "string") return error.details;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return "The GenLayer request failed without an error message.";
}

function Flow() {
  const steps = ["AI Agent", "AgentGate", "GenLayer Validators", "ALLOW / BLOCK"];

  return (
    <section className="flow" aria-label="AgentGate evaluation flow">
      {steps.map((step, index) => (
        <div className="flow-item" key={step}>
          <span className={step === "AgentGate" ? "flow-node active" : "flow-node"}>{step}</span>
          {index < steps.length - 1 && <span className="arrow" aria-hidden="true">→</span>}
        </div>
      ))}
    </section>
  );
}

function Field({ label, name, value, onChange }) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea name={name} value={value} onChange={onChange} rows="3" required />
    </label>
  );
}

function ResultCard({ result, status }) {
  if (status === "idle") {
    return (
      <div className="result-empty">
        <span className="result-icon">◇</span>
        <h2>Awaiting evaluation</h2>
        <p>Your finalized GenLayer result will appear here.</p>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div className="result-empty" role="status">
        <span className="spinner" />
        <h2>Evaluating action</h2>
        <p>GenLayer validators are evaluating this action...</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="result-card error" role="alert">
        <span className="eyebrow">Transaction error</span>
        <h2>Evaluation unavailable</h2>
        <p>{result}</p>
      </div>
    );
  }

  const isAllow = result.decision === "ALLOW";
  return (
    <div className={`result-card ${isAllow ? "allow" : "block"}`} aria-live="polite">
      <div className="result-heading">
        <span className="decision-mark">{isAllow ? "✓" : "×"}</span>
        <div>
          <span className="eyebrow">Decision</span>
          <h2>{result.decision}</h2>
        </div>
      </div>
      <div className="result-details">
        <div>
          <span className="detail-label">Risk level</span>
          <strong>{result.risk}</strong>
        </div>
        <div>
          <span className="detail-label">Reason</span>
          <p>{result.reason}</p>
        </div>
      </div>
      <p className="result-source">GenLayer result · Studionet</p>
    </div>
  );
}

export default function App() {
  const [inputs, setInputs] = useState(INITIAL_INPUTS);
  const [status, setStatus] = useState("idle");
  const [result, setResult] = useState(null);
  const [transactionHash, setTransactionHash] = useState("");
  const evaluationPending = useRef(false);

  const handleChange = (event) => {
    setInputs((current) => ({ ...current, [event.target.name]: event.target.value }));
  };

  const evaluate = async (event) => {
    event.preventDefault();
    if (evaluationPending.current) return;

    evaluationPending.current = true;
    setStatus("loading");
    setResult(null);
    setTransactionHash("");

    try {
      const evaluation = await evaluateWithGenLayer(inputs);
      setResult(evaluation.result);
      setTransactionHash(evaluation.transactionHash);
      setStatus("success");
    } catch (error) {
      console.error("AgentGate GenLayer transaction failed", {
        error,
        message: error?.message,
        cause: error?.cause,
        code: error?.code,
        data: error?.data,
      });
      setResult(getErrorMessage(error));
      setStatus("error");
    } finally {
      evaluationPending.current = false;
    }
  };

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="AgentGate home">
          <span className="brand-mark">AG</span>
          <span>AgentGate</span>
        </a>
        <span className="status-pill connected"><i /> Studionet</span>
      </header>

      <div className="page" id="top">
        <section className="hero">
          <span className="kicker">Decentralized AI judgment</span>
          <h1>Trust layer for<br /><em>autonomous AI agents</em></h1>
          <p>Evaluate high-impact agent actions against context and policy before they execute.</p>
        </section>

        <Flow />

        <section className="workspace">
          <form className="panel input-panel" onSubmit={evaluate}>
            <div className="panel-heading">
              <div>
                <span className="step-number">01</span>
                <h2>Action request</h2>
              </div>
              <span className="required">All fields required</span>
            </div>

            <Field label="Action" name="action" value={inputs.action} onChange={handleChange} />
            <Field label="Context" name="context" value={inputs.context} onChange={handleChange} />
            <Field label="Policy" name="policy" value={inputs.policy} onChange={handleChange} />

            <button className="evaluate-button" disabled={status === "loading"} type="submit">
              <span>{status === "loading" ? "Evaluating…" : "Evaluate Action"}</span>
              <span aria-hidden="true">→</span>
            </button>
            <p className="network-notice">Browser wallet · GenLayer Studionet · Chain 61999</p>
          </form>

          <section className="panel result-panel">
            <div className="panel-heading">
              <div>
                <span className="step-number">02</span>
                <h2>Risk assessment</h2>
              </div>
              <span className="network-label">LIVE NETWORK</span>
            </div>
            <ResultCard result={result} status={status} />
            {transactionHash && <p className="transaction-id">Transaction: {transactionHash}</p>}
          </section>
        </section>
      </div>

      <footer>
        <span>AgentGate MVP</span>
        <span>Built for verifiable agent safety</span>
      </footer>
    </main>
  );
}
