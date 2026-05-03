/**
 * Pre-flight "what to expect" hint shown above the Boost button on
 * both the show-boost and episode-boost modals.
 *
 * Two facts the donor benefits from knowing before clicking:
 *
 *   1. Signer prompts (kind 30078 receipts + optional kind 1 share)
 *      fire BEFORE the modal closes. NDK-via-extension users may see
 *      one inline browser prompt; bunker/Amber users may see one
 *      tab-switch per prompt — easy to miss the second one if they
 *      think the flow is over after the first.
 *
 *   2. Wallet prompts (the actual payments) fire AFTER the modal
 *      closes. NWC handles them silently; WebLN extensions prompt
 *      per-payment unless the donor has configured a per-site
 *      auto-pay budget.
 *
 * Adaptive rendering — only surfaces lines that are actually relevant
 * to this donor's config:
 *   - Anonymous mode → no signer line (everything is burner-signed).
 *   - NWC wallet     → no wallet line (silent).
 *   - WebLN single-leg → simpler "1 payment" wording.
 *   - Both lines hidden → render nothing rather than an empty box.
 */
export default function BoostExpectations({
  walletKind,         // 'nwc' | 'webln'
  anonymous,          // anon mode skips all signer prompts
  allowlistedCount,   // # of recipients getting a kind 30078 (one signer prompt each)
  shareToFeed,        // donor opted into the kind 1 share post (one extra prompt)
  canShareToFeed,     // share-to-feed even available (signed-in + not anon)
  splitsCount,        // total payment legs (informs the wallet-prompt line)
}) {
  // Anon mode → all metadata events are burner-signed, so the donor
  // sees zero signer prompts. Otherwise: one prompt per allowlisted
  // leg, plus one for the optional kind-1 share post. Centralised
  // here so both boost modals stay in lockstep when the rule changes.
  const signerPromptCount = anonymous
    ? 0
    : allowlistedCount + (shareToFeed && canShareToFeed ? 1 : 0)

  const showSigner = signerPromptCount > 0
  const showWallet = walletKind === 'webln' && splitsCount > 0

  if (!showSigner && !showWallet) return null

  return (
    <div className="text-[11px] text-neutral-400 leading-snug rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2.5 space-y-1.5">
      <p className="text-[10px] uppercase tracking-wider text-neutral-500">
        <span className="text-orange-400">This boost has zap splits!</span>
        {' — '}What to expect:
      </p>
      <ul className="space-y-1">
        {showSigner && (
          <li className="flex gap-2">
            <span className="text-neutral-600 select-none">•</span>
            <span>
              Your signer will ask to approve{' '}
              <span className="font-semibold text-neutral-300">
                {signerPromptCount} {signerPromptCount === 1 ? 'receipt' : 'receipts'}
              </span>{' '}
              before the modal closes
            </span>
          </li>
        )}
        {showWallet && (
          <li className="flex gap-2">
            <span className="text-neutral-600 select-none">•</span>
            <span>
              Your extension may ask to approve{' '}
              <span className="font-semibold text-neutral-300">
                {splitsCount === 1
                  ? '1 payment'
                  : `up to ${splitsCount} payments`}
              </span>{' '}
              {splitsCount > 1 && '— set an auto-pay budget for this site to skip these'}
            </span>
          </li>
        )}
      </ul>
    </div>
  )
}
