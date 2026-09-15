import { createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { createTransactionKit } from "@genlayer/transaction-kit";

const contractAddress = import.meta.env.VITE_AGENTGATE_CONTRACT_ADDRESS;
const GENLAYER_SNAP_ID = "npm:genlayer-wallet-plugin";
const METAMASK_RDNS = new Set(["io.metamask", "io.metamask.flask"]);

if (!/^0x[a-fA-F0-9]{40}$/.test(contractAddress ?? "")) {
  throw new Error("VITE_AGENTGATE_CONTRACT_ADDRESS is missing or invalid.");
}

const readClient = createClient({ chain: studioDevnet });

function formatStatus(status) {
  if (!status) return "Submitted";
  return String(status)
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function trackDecision(transactionKit, transactionHash, onStatus) {
  let latestStatus = { phase: "submitted", genlayerTxId: transactionHash };
  try {
    const status = await transactionKit.track(
      transactionHash,
      (nextStatus) => {
        latestStatus = nextStatus;
        const queueSuffix = Number.isFinite(nextStatus.queuePosition)
          ? ` (${nextStatus.queuePosition} ahead)`
          : "";
        onStatus?.(`${formatStatus(nextStatus.statusName ?? nextStatus.phase)}${queueSuffix}`);
      },
      { until: "decided" },
    );
    return { status, stillProcessing: false };
  } catch (error) {
    if (
      /Timed out tracking GenLayer transaction/i.test(error?.message ?? "")
      && ["submitted", "pending", "processing"].includes(latestStatus.phase)
    ) {
      return { status: latestStatus, stillProcessing: true };
    }
    throw error;
  }
}

function getLegacyMetaMaskProvider() {
  const injected = window.ethereum;
  const providers = Array.isArray(injected?.providers) ? injected.providers : [injected];

  return providers.find((provider) => provider?.isMetaMask && typeof provider.request === "function") ?? null;
}

function discoverMetaMaskProvider() {
  return new Promise((resolve) => {
    const discovered = new Map();
    let timeoutId;

    const finish = (provider) => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("eip6963:announceProvider", handleAnnouncement);
      resolve(provider ?? getLegacyMetaMaskProvider());
    };

    const handleAnnouncement = (event) => {
      const { info, provider } = event.detail ?? {};
      if (!METAMASK_RDNS.has(info?.rdns) || typeof provider?.request !== "function") return;

      discovered.set(info.rdns, provider);
      if (info.rdns === "io.metamask") finish(provider);
    };

    window.addEventListener("eip6963:announceProvider", handleAnnouncement);
    timeoutId = window.setTimeout(
      () => finish(discovered.get("io.metamask.flask")),
      500,
    );
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  });
}

function hasRpcErrorCode(error, code) {
  const errorCode = error?.code ?? error?.data?.originalError?.code ?? error?.cause?.code;
  return Number(errorCode) === code;
}

async function requestSnapMethod(provider, request) {
  try {
    return await provider.request(request);
  } catch (error) {
    if (hasRpcErrorCode(error, -32601) || /method not found/i.test(error?.message ?? "")) {
      throw new Error(
        "This MetaMask provider does not support Snaps. Update or enable the MetaMask browser extension, reload AgentGate, and try again.",
      );
    }
    throw error;
  }
}

async function connectMetaMaskToStudioNext(provider) {
  const chainId = `0x${studioDevnet.id.toString(16)}`;
  const currentChainId = await provider.request({ method: "eth_chainId" });

  if (currentChainId.toLowerCase() !== chainId) {
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId }],
      });
    } catch (error) {
      if (!hasRpcErrorCode(error, 4902)) throw error;

      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId,
          chainName: studioDevnet.name,
          rpcUrls: studioDevnet.rpcUrls.default.http,
          nativeCurrency: studioDevnet.nativeCurrency,
        }],
      });
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId }],
      });
    }
  }

  const installedSnaps = await requestSnapMethod(provider, { method: "wallet_getSnaps" });
  const genLayerSnap = Object.values(installedSnaps ?? {}).find(
    (snap) => snap.id === GENLAYER_SNAP_ID,
  );

  if (genLayerSnap?.blocked) {
    throw new Error("The GenLayer Snap is blocked in MetaMask. Unblock it in MetaMask Snaps settings and try again.");
  }

  if (genLayerSnap?.enabled === false) {
    throw new Error("The GenLayer Snap is disabled in MetaMask. Enable it in MetaMask Snaps settings and try again.");
  }

  if (!genLayerSnap) {
    await requestSnapMethod(provider, {
      method: "wallet_requestSnaps",
      params: { [GENLAYER_SNAP_ID]: {} },
    });
  }
}

async function connectMetaMaskAccount(provider) {
  let accounts = await provider.request({ method: "eth_accounts" });

  if (!accounts?.[0]) {
    const requestedAccounts = await provider.request({ method: "eth_requestAccounts" });
    accounts = await provider.request({ method: "eth_accounts" });

    if (!accounts?.[0] && requestedAccounts?.[0]) {
      accounts = requestedAccounts;
    }
  }

  if (!accounts?.[0]) {
    throw new Error("No wallet account was selected.");
  }

  return accounts[0];
}

export async function evaluateWithGenLayer(
  { action, context, policy },
  { onSubmitted, onStatus } = {},
) {
  const provider = await discoverMetaMaskProvider();
  if (!provider) {
    throw new Error("MetaMask was not found. Install or enable the MetaMask browser extension, then reload AgentGate.");
  }

  let account = await connectMetaMaskAccount(provider);
  await connectMetaMaskToStudioNext(provider);

  const activeAccounts = await provider.request({ method: "eth_accounts" });
  account = activeAccounts?.[0] ?? account;

  const transactionKit = createTransactionKit({
    chain: studioDevnet,
    account,
    provider,
  });

  const transaction = {
    kind: "write",
    address: contractAddress,
    method: "evaluate_action",
    args: [action, context, policy],
  };

  onStatus?.("Estimating fees");
  const quote = await transactionKit.estimate({ preset: "standard" }, transaction);
  if (quote.verification.status === "mismatch") {
    throw new Error("GenLayer fee policy changed while preparing the transaction. Please try again.");
  }

  onStatus?.("Waiting for wallet signature");
  const { genlayerTxId: transactionHash } = await transactionKit.submit(quote, transaction);
  onSubmitted?.(transactionHash);
  onStatus?.("Submitted");

  const tracked = await trackDecision(transactionKit, transactionHash, onStatus);
  if (tracked.stillProcessing) {
    return {
      consensusStatus: formatStatus(tracked.status.statusName ?? tracked.status.phase),
      stillProcessing: true,
      transactionHash,
    };
  }

  if (!tracked.status.successful) {
    const displayedStatus = tracked.status.statusName ?? tracked.status.phase;
    const displayedExecution = tracked.status.executionResultName ?? "execution failed";
    throw new Error(
      `GenLayer transaction ${transactionHash} failed: consensus ${displayedStatus}; execution ${displayedExecution}.`,
    );
  }

  const [decision, risk, reason] = await Promise.all([
    readClient.readContract({
      address: contractAddress,
      functionName: "get_decision",
      args: [],
    }),
    readClient.readContract({
      address: contractAddress,
      functionName: "get_risk",
      args: [],
    }),
    readClient.readContract({
      address: contractAddress,
      functionName: "get_reason",
      args: [],
    }),
  ]);
  const result = { decision, risk, reason };

  if (
    !result ||
    !["ALLOW", "BLOCK"].includes(result.decision) ||
    !["LOW", "MEDIUM", "HIGH"].includes(result.risk) ||
    typeof result.reason !== "string" ||
    !result.reason.trim()
  ) {
    throw new Error("AgentGate returned an invalid evaluation result.");
  }

  return { result, transactionHash };
}
