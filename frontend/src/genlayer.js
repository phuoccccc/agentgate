import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { ExecutionResult, TransactionHashVariant, TransactionStatus } from "genlayer-js/types";

const contractAddress = import.meta.env.VITE_AGENTGATE_CONTRACT_ADDRESS;
const GENLAYER_SNAP_ID = "npm:genlayer-wallet-plugin";
const METAMASK_RDNS = new Set(["io.metamask", "io.metamask.flask"]);

if (!/^0x[a-fA-F0-9]{40}$/.test(contractAddress ?? "")) {
  throw new Error("VITE_AGENTGATE_CONTRACT_ADDRESS is missing or invalid.");
}

const readClient = createClient({ chain: studionet });

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

async function connectMetaMaskToStudionet(provider) {
  const chainId = `0x${studionet.id.toString(16)}`;
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
          chainName: studionet.name,
          rpcUrls: studionet.rpcUrls.default.http,
          nativeCurrency: studionet.nativeCurrency,
          blockExplorerUrls: [studionet.blockExplorers.default.url],
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

export async function evaluateWithGenLayer({ action, context, policy }) {
  const provider = await discoverMetaMaskProvider();
  if (!provider) {
    throw new Error("MetaMask was not found. Install or enable the MetaMask browser extension, then reload AgentGate.");
  }

  let account = await connectMetaMaskAccount(provider);
  // genlayer-js 1.1.8 connect() ignores its configured provider and uses window.ethereum.
  await connectMetaMaskToStudionet(provider);

  const activeAccounts = await provider.request({ method: "eth_accounts" });
  account = activeAccounts?.[0] ?? account;

  const writeClient = createClient({
    chain: studionet,
    account,
    provider,
  });

  const transactionHash = await writeClient.writeContract({
    address: contractAddress,
    functionName: "evaluate_action",
    args: [action, context, policy],
    value: 0n,
  });

  const receipt = await readClient.waitForTransactionReceipt({
    hash: transactionHash,
    status: TransactionStatus.ACCEPTED,
    fullTransaction: true,
  });

  const statusCode = Number(receipt.status);
  const consensusStatus = receipt.statusName
    ?? receipt.status_name
    ?? (statusCode === 5 ? TransactionStatus.ACCEPTED : null)
    ?? (statusCode === 7 ? TransactionStatus.FINALIZED : receipt.status);
  const rawLeaderReceipts = receipt.consensus_data?.leader_receipt;
  const leaderReceipts = Array.isArray(rawLeaderReceipts)
    ? rawLeaderReceipts
    : rawLeaderReceipts ? [rawLeaderReceipts] : [];
  const selectedLeaderReceipt = [...leaderReceipts]
    .reverse()
    .find((leaderReceipt) => leaderReceipt?.execution_result);
  const rawExecutionResult = selectedLeaderReceipt?.execution_result;
  const canonicalExecutionResult = receipt.txExecutionResultName;
  const normalizedExecutionResult = canonicalExecutionResult
    ?? (rawExecutionResult === "SUCCESS" ? ExecutionResult.FINISHED_WITH_RETURN : null)
    ?? (rawExecutionResult === "ERROR" ? ExecutionResult.FINISHED_WITH_ERROR : null);
  const success = normalizedExecutionResult === ExecutionResult.FINISHED_WITH_RETURN;
  const acceptedOrFinalized = [
    TransactionStatus.ACCEPTED,
    TransactionStatus.FINALIZED,
  ].includes(consensusStatus);

  console.log("AgentGate normalized execution:", {
    consensusStatus,
    rawExecutionResult,
    canonicalExecutionResult,
    success,
  });

  if (!acceptedOrFinalized || !success) {
    console.error("AgentGate failed transaction hash:", transactionHash);
    console.error("AgentGate failed receipt:", receipt);
    console.error("AgentGate failed execution fields:", {
      status: receipt.status,
      status_name: consensusStatus,
      consensus_data: receipt.consensus_data,
      leader_receipt: leaderReceipts,
      execution_result: rawExecutionResult,
      txExecutionResultName: canonicalExecutionResult,
      result: receipt.result,
      error: receipt.error,
      message: receipt.message,
      data: receipt.data,
    });

    try {
      const transaction = await readClient.getTransaction({ hash: transactionHash });
      console.error("AgentGate failed transaction data:", transaction);
    } catch (lookupError) {
      console.error("AgentGate failed transaction lookup:", lookupError);
    }

    const displayedStatus = consensusStatus ?? `status code ${receipt.status ?? "missing"}`;
    const displayedExecution = normalizedExecutionResult
      ?? rawExecutionResult
      ?? "missing execution result";
    throw new Error(
      `GenLayer transaction ${transactionHash} failed: consensus ${displayedStatus}; execution ${displayedExecution}.`,
    );
  }

  const result = await readClient.readContract({
    address: contractAddress,
    functionName: "get_last_evaluation",
    args: [],
    transactionHashVariant: TransactionHashVariant.LATEST_NONFINAL,
  });

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
