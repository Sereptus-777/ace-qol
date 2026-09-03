// ─── ACE: QOL — A corpse does not turn, and a corpse does not aim ────────────
//
// Johnny, 2026-09-02, with a dead shadow dragon selected and its whole attack
// bar showing: "Let's stop token facing on anything that's dead as well, so I
// can't turn around, and it shouldn't even be able to target."
//
// ⚠️🔴 THE ATTACK ITSELF IS ALREADY REFUSED, AND THAT WAS NOT ENOUGH. The gate
// stops a dead creature acting, so pressing Rend gets a refusal. But everything
// UP TO that point still behaved like a living creature: the body swung round to
// face whatever he moved the cursor toward, and it could put reticles on the
// party. A refusal that arrives only at the very end reads as a bug in the
// refusal, not as a corpse.
//
// Two locks, both cosmetic-layer, neither touching the rules:
//
//   1. ROTATION. Blocked in `preUpdateToken`, which is the only place every
//      route meets — the rotate handles, the keyboard, and Foundry V13's own
//      auto-rotate on movement all end up there. Blocking any one of them would
//      have left the other two working, which is the class-not-instance rule.
//
//   2. TARGETING. Refused while every token the user controls is dead. Scoped
//      that way on purpose: a GM with a live token also selected is targeting
//      for that one, and stealing his reticles then would be its own bug.
//
// ⚠️ IT NEVER BLOCKS THE GM MOVING OR DELETING A CORPSE. He drags bodies around
// and bumps their hit points to bring them back; only the rotation field is
// removed from the update, never the update.
const MODULE_ID = "ace-qol";

export class DeadTokenLock {

  /** Say each refusal once per token, not once per mouse movement. */
  static _told = new Set();

  /**
   * Is this token a corpse?
   *
   * ⚠️ THE FLAG AND THE HIT POINTS, NEVER THE `dead` STATUS. The death pipeline
   * removes that status on purpose so Foundry's skull does not stack on the
   * corpse artwork, and the condition sweep clears everything else. A corpse in
   * this suite carries no marker at all, which is exactly how a dead dragon came
   * to attack a player character.
   */
  static isDead(tokenDoc) {
    try {
      const doc = tokenDoc?.document ?? tokenDoc;
      if (doc?.flags?.[MODULE_ID]?.isDead) return true;
      const raw = doc?.actor?.system?.attributes?.hp?.value;
      const hp = Number(raw);
      // An actor with no hit points at all is not a corpse, it is a thing this
      // question does not apply to. NaN must never read as zero.
      if (!Number.isFinite(hp)) return false;
      return hp <= 0;
    } catch (err) {
      // ⚠️ FAIL OPEN AND SAY SO. Locking a token he cannot then unlock would be
      // far worse than the thing this prevents.
      console.warn(`${MODULE_ID} | could not tell whether this token is dead, so it `
        + `keeps its facing and targeting:`, err);
      return false;
    }
  }

  static _sayOnce(key, message) {
    if (DeadTokenLock._told.has(key)) return;
    DeadTokenLock._told.add(key);
    if (DeadTokenLock._told.size > 200) DeadTokenLock._told.clear();
    ui.notifications?.info(message);
  }

  /**
   * "This token is dead. Are you sure you want to target it?"
   *
   * ⚠️ A DARK ACE WRAPPER, NOT A BARE DIALOG. Foundry's default dialog is light
   * parchment, so ACE's own colours are invisible on it — this is a standing
   * rule in the suite, and every dialog that ignored it had to be redone.
   * Body 16px, heading 18px, which are the floors for anything ACE puts over
   * Foundry's chrome.
   *
   * ⚠️ ONE QUESTION AT A TIME. A drag-select across a pile of bodies would
   * otherwise stack a dialog per corpse; while one is open the rest are
   * dropped rather than queued.
   */
  static async _askBeforeTargeting(token, context = {}) {
    if (DeadTokenLock._asking) return;
    DeadTokenLock._asking = true;
    try {
      const esc = foundry.utils.escapeHTML;
      const name = esc(token?.name ?? "This token");
      const img  = esc(token?.document?.texture?.src ?? token?.actor?.img ?? "");

      const content = `
        <div style="background:linear-gradient(180deg,#15110d 0%,#0c0a08 100%);
                    border:2px solid #d4af37;border-radius:8px;padding:16px 18px;
                    color:#f0e4c0;font-family:'Signika','Helvetica Neue',sans-serif;">
          <div style="display:flex;align-items:center;gap:14px;">
            ${img ? `<img src="${img}" alt="" style="width:64px;height:64px;object-fit:cover;
                       border-radius:6px;border:1px solid #6b5530;flex:0 0 auto;">` : ""}
            <div>
              <div style="font-size:18px;font-weight:700;color:#ff6b3d;letter-spacing:.5px;
                          margin-bottom:6px;">
                <i class="fas fa-skull" style="margin-right:7px;"></i>${name} is dead.
              </div>
              <div style="font-size:16px;line-height:1.5;color:#f0e4c0;">
                Are you sure you want to target it?
              </div>
            </div>
          </div>
          <div style="font-size:14px;line-height:1.45;color:#c0b288;font-style:italic;
                      margin-top:12px;">
            Targeting a body is fine when you mean to — raising it, burning it, or
            catching it in an area. This only asks so a stray click does not put a
            spell into a corpse.
          </div>
        </div>`;

      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: "ACE — Target a dead creature?" },
        position: { width: 520 },
        content,
        modal: true,
        yes: { default: false, label: "Target it", icon: "fa-solid fa-crosshairs" },
        no:  { default: true,  label: "Cancel" },
        rejectClose: false,
      }).catch(() => false);

      if (!ok) return;
      // ⚠️ THE ORIGINAL, NOT THE PATCHED ONE. Calling through the patch again
      // with the flag would work, but going straight to what Foundry shipped
      // means a future edit to the branch above cannot accidentally re-ask.
      DeadTokenLock._setTarget?.call(token, true,
        { ...context, aceDeadTargetConfirmed: true });
    } catch (err) {
      console.error(`${MODULE_ID} | could not ask about targeting a dead creature, `
        + `so nothing was targeted:`, err);
    } finally {
      DeadTokenLock._asking = false;
    }
  }

  static register() {
    // ── 1. A corpse does not turn ────────────────────────────────────────
    Hooks.on("preUpdateToken", (tokenDoc, changes) => {
      try {
        if (changes?.rotation === undefined) return;
        if (!DeadTokenLock.isDead(tokenDoc)) return;
        // ⚠️ REMOVE THE FIELD, NEVER REFUSE THE UPDATE. Returning false here
        // would also cancel the x/y in the same payload, so dragging a body
        // across the room would silently do nothing.
        delete changes.rotation;
        DeadTokenLock._sayOnce(`rot:${tokenDoc.id}`,
          `${tokenDoc.name} is dead and no longer turns to face anything.`);
      } catch (err) {
        console.warn(`${MODULE_ID} | the dead-token facing lock threw:`, err);
      }
    });

    // ── 2. A corpse does not aim ─────────────────────────────────────────
    try {
      const TokenClass = CONFIG?.Token?.objectClass;
      if (!TokenClass?.prototype) {
        console.warn(`${MODULE_ID} | no Token class yet, so a dead creature can still `
          + `place targets.`);
      } else if (!TokenClass.prototype.__aceDeadTargetLock) {
        const original = TokenClass.prototype.setTarget;
        DeadTokenLock._setTarget = original;
        TokenClass.prototype.setTarget = function (targeted = true, context = {}) {
          try {
            // Clearing a target is always allowed — otherwise reticles placed
            // before something died could never be taken off again.
            if (targeted) {
              const controlled = canvas?.tokens?.controlled ?? [];
              if (controlled.length && controlled.every(t => DeadTokenLock.isDead(t))) {
                DeadTokenLock._sayOnce(`tgt:${controlled[0]?.id}`,
                  `${controlled[0]?.name ?? "That creature"} is dead and cannot target anything.`);
                return;
              }

              // ── Targeting a corpse: ask, do not refuse ──────────────────
              //
              // Johnny, 2026-09-02: "I don't think you should be able to target
              // a dead thing... 'This token is dead. Are you sure you want to
              // target it?'" and then, a minute later, "and you should be able
              // to target it." So it is a question, never a wall: a GM aims at
              // corpses on purpose all the time, to raise them, to burn them,
              // to check a save they should not have to argue about.
              //
              // ⚠️ setTarget IS SYNCHRONOUS AND A DIALOG IS NOT. So this bails
              // out of the current call, asks, and calls the ORIGINAL again on
              // yes with a flag that skips this branch. Trying to await here
              // would return a promise to Foundry, which expects nothing, and
              // the reticle would land before he ever saw the question.
              if (!context?.aceDeadTargetConfirmed && DeadTokenLock.isDead(this)) {
                DeadTokenLock._askBeforeTargeting(this, context);
                return;
              }
            }
          } catch (err) {
            console.warn(`${MODULE_ID} | the dead-token targeting lock threw, so the `
              + `target is being allowed:`, err);
          }
          return original.call(this, targeted, context);
        };
        TokenClass.prototype.__aceDeadTargetLock = true;
      }
    } catch (err) {
      console.error(`${MODULE_ID} | the dead-token targeting lock failed to install:`, err);
    }

    // A corpse that stops being a corpse should be able to turn and aim again,
    // and should be able to say so again if it dies twice.
    Hooks.on("updateToken", (tokenDoc) => {
      try {
        if (DeadTokenLock.isDead(tokenDoc)) return;
        DeadTokenLock._told.delete(`rot:${tokenDoc.id}`);
        DeadTokenLock._told.delete(`tgt:${tokenDoc.id}`);
      } catch (_) { /* nothing to forget */ }
    });

    console.log(`${MODULE_ID} | dead tokens no longer turn to face or place targets.`);
  }
}
