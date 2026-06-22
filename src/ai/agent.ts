import { FailureType, AgentDecision, LifecycleLogEntry } from '../types';

/**
 * AI Agent that makes real operational decisions in the transaction stack.
 * Uses an LLM to reason about failures and decide on corrective actions.
 * 
 * This agent implements the "Autonomous Retry with Fault Injection" pattern:
 * 1. Detects failures (including simulated blockhash expiry)
 * 2. Reasons about the root cause
 * 3. Decides on corrective action
 * 4. Refreshes state and resubmits autonomously
 */
export class TransactionAgent {
  private apiKey: string;
  private model: string;
  private decisionLog: AgentDecision[] = [];

  constructor(apiKey: string, model: string = 'gpt-4o-mini') {
    this.apiKey = apiKey;
    this.model = model;
  }

  /**
   * Analyze a transaction failure and decide what to do.
   * This is the core AI decision point - the agent MUST reason, not just follow rules.
   */
  async analyzeFailure(
    failureType: FailureType,
    failureMessage: string,
    context: {
      currentTip: number;
      recentNetworkFees: number[];
      currentSlot: number;
      attemptNumber: number;
      previousDecisions: AgentDecision[];
    }
  ): Promise<AgentDecision> {
    const prompt = this.buildFailurePrompt(failureType, failureMessage, context);
    const decision = await this.queryLLM(prompt);
    
    this.decisionLog.push(decision);
    return decision;
  }

  /**
   * Decide on tip amount for a bundle submission based on network conditions.
   */
  async decideTip(
    context: {
      recentTips: number[];
      currentSlot: number;
      urgency: 'low' | 'medium' | 'high';
      landingTarget: number;
    }
  ): Promise<AgentDecision> {
    const prompt = `You are the tip decision engine for a Solana Jito bundle submission system.

Current context:
- Recent successful tips (lamports): [${context.recentTips.join(', ')}]
- Current slot: ${context.currentSlot}
- Urgency: ${context.urgency}
- Landing target: ${context.landingTarget}%

Your task: Decide the optimal tip amount in lamports. Balance cost vs. landing probability.

Consider:
1. Higher tips = higher landing probability but more cost
2. Network congestion affects optimal tip
3. Historical tip data shows what landed recently
4. Urgency affects how much we should be willing to pay

Return a JSON decision with:
{
  "action": "adjust_tip",
  "reasoning": "your detailed analysis",
  "parameters": {
    "newTipAmount": number (in lamports),
    "reason": "brief reason"
  }
}`;

    return this.queryLLM(prompt);
  }

  /**
   * Decide when to submit based on leader schedule and slot conditions.
   */
  async decideSubmissionTiming(
    context: {
      currentSlot: number;
      currentLeader: string;
      nextLeader: string | null;
      nextLeaderSlot: number | null;
      isJitoWindow: boolean;
      recentFailureRate: number;
    }
  ): Promise<AgentDecision> {
    const prompt = `You are the submission timing engine for a Solana Jito bundle system.

Current conditions:
- Current slot: ${context.currentSlot}
- Current leader: ${context.currentLeader}
- Next leader: ${context.nextLeader || 'unknown'}
- Next leader slot: ${context.nextLeaderSlot || 'unknown'}
- Is Jito window: ${context.isJitoWindow}
- Recent failure rate: ${context.recentFailureRate * 100}%

Your task: Decide whether to submit now, hold, or wait for the next leader window.

Return JSON:
{
  "action": "submit_now" | "hold" | "wait_for_leader",
  "reasoning": "your analysis",
  "parameters": {
    "waitSlots": number (if holding),
    "reason": "brief reason"
  }
}`;

    return this.queryLLM(prompt);
  }

  /**
   * Build the prompt for failure analysis
   */
  private buildFailurePrompt(
    failureType: FailureType,
    failureMessage: string,
    context: {
      currentTip: number;
      recentNetworkFees: number[];
      currentSlot: number;
      attemptNumber: number;
      previousDecisions: AgentDecision[];
    }
  ): string {
    const previousDecisionsStr = context.previousDecisions.length > 0
      ? context.previousDecisions.map((d, i) =>
          `Attempt ${i + 1}: action=${d.action}, reasoning="${d.reasoning}"`
        ).join('\n')
      : 'No previous attempts.';

    return `You are the autonomous retry agent for a Solana Jito bundle submission system. Your job is to analyze transaction failures and decide what corrective action to take.

FAILURE DETAILS:
- Type: ${failureType}
- Message: ${failureMessage}
- Current tip amount: ${context.currentTip} lamports
- Recent network fees (microLamports): [${context.recentNetworkFees.join(', ')}]
- Current slot: ${context.currentSlot}
- Attempt number: ${context.attemptNumber}

PREVIOUS DECISIONS:
${previousDecisionsStr}

YOUR TASK:
Analyze the failure and decide ONE of the following actions:
1. "retry" - Retry the transaction, possibly with adjusted parameters
2. "adjust_tip" - Increase/decrease the tip and retry
3. "hold" - Wait for better network conditions
4. "abort" - Give up on this transaction

Consider:
- Expired blockhash → refresh blockhash and retry
- Fee too low → increase tip
- Compute exceeded → optimize or split transaction
- Bundle failure → check leader schedule, adjust timing
- Repeated failures → consider holding or aborting

Return your decision as a JSON object (ONLY valid JSON, no markdown):
{
  "action": "retry" | "adjust_tip" | "hold" | "abort",
  "reasoning": "Your detailed reasoning about what caused the failure and why you chose this action. Be specific about the technical cause.",
  "parameters": {
    "newTipAmount": number | null,
    "waitSlots": number | null,
    "reason": "Brief reason"
  }
}`;
  }

  /**
   * Query the LLM for a decision
   */
  private async queryLLM(prompt: string): Promise<AgentDecision> {
    if (!this.apiKey) {
      console.warn('[AI Agent] No API key configured. Using fallback decision logic.');
      return this.fallbackDecision(prompt);
    }

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: 'You are a Solana infrastructure AI agent that makes real operational decisions. You output ONLY valid JSON.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 500,
        }),
      });

      if (!response.ok) {
        throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content || '';

      // Parse JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          action: parsed.action || 'retry',
          reasoning: parsed.reasoning || 'No reasoning provided',
          parameters: parsed.parameters || {},
        };
      }

      throw new Error('Could not parse JSON from LLM response');
    } catch (err) {
      console.error(`[AI Agent] LLM query failed: ${err}`);
      return this.fallbackDecision(prompt);
    }
  }

  /**
   * Fallback decision logic when LLM is unavailable
   */
  private fallbackDecision(prompt: string): AgentDecision {
    // Extract failure type from prompt
    const isExpiredBlockhash = prompt.includes('expired_blockhash');
    const isFeeTooLow = prompt.includes('fee_too_low') || prompt.includes('Fee too low');
    const isComputeExceeded = prompt.includes('compute_exceeded');
    const isBundleFailure = prompt.includes('bundle_failure');
    const attemptNum = parseInt(prompt.match(/Attempt number: (\d+)/)?.[1] || '1');

    if (isExpiredBlockhash) {
      return {
        action: 'retry',
        reasoning: 'Blockhash expired. This is expected behavior. Refreshing blockhash via getLatestBlockhash and resubmitting with fresh parameters.',
        parameters: { reason: 'Blockhash expired - refresh and retry' },
      };
    }

    if (isFeeTooLow || isBundleFailure) {
      const tipIncrease = Math.min(100000, 50000 * attemptNum);
      return {
        action: 'adjust_tip',
        reasoning: `Transaction failed due to insufficient fee or bundle rejection. Increasing tip by ${tipIncrease} lamports to improve landing probability.`,
        parameters: {
          newTipAmount: tipIncrease,
          reason: `Increasing tip for attempt ${attemptNum + 1}`,
        },
      };
    }

    if (isComputeExceeded) {
      return {
        action: 'hold',
        reasoning: 'Compute budget exceeded. Holding and will split transaction into smaller chunks on retry.',
        parameters: { waitSlots: 2, reason: 'Compute limit hit - splitting transaction' },
      };
    }

    if (attemptNum >= 5) {
      return {
        action: 'abort',
        reasoning: `Failed after ${attemptNum} attempts with persistent errors. Aborting to prevent wasted compute.`,
        parameters: { reason: 'Max retry attempts reached' },
      };
    }

    return {
      action: 'retry',
      reasoning: 'Unknown failure cause. Refreshing blockhash and retrying with same parameters.',
      parameters: { reason: 'Retry with refreshed state' },
    };
  }

  getDecisionLog(): AgentDecision[] {
    return this.decisionLog;
  }
}
