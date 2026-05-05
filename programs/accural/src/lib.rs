use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("HTVTUMeyRkpbakNASCQ44MzgjxKjrV5oG8rBSavMiPCS");

const MAX_AGENT_ID_LEN: usize = 32;
const MAX_TASK_ID_LEN: usize = 32;
const MAX_PURPOSE_LEN: usize = 160;
const MAX_PROOF_URI_LEN: usize = 200;
const MAX_SERVICE_TYPE_LEN: usize = 32;
const MAX_DESCRIPTION_LEN: usize = 160;
const ACTION_REQUEST_PAYMENT: u16 = 1 << 0;
const ACTION_CREATE_ESCROW: u16 = 1 << 1;
const ACTION_RELEASE_ESCROW: u16 = 1 << 2;
const ACTION_DIRECT_PAYMENT: u16 = 1 << 3;

#[program]
pub mod accural {
    use super::*;

    pub fn initialize_agent(ctx: Context<InitializeAgent>, agent_id: String) -> Result<()> {
        validate_id(&agent_id, MAX_AGENT_ID_LEN, AccuralError::InvalidAgentId)?;

        let registry = &mut ctx.accounts.agent_registry;
        registry.owner = ctx.accounts.owner.key();
        registry.agent_id = agent_id;
        registry.bump = ctx.bumps.agent_registry;

        let policy = &mut ctx.accounts.policy_vault;
        policy.agent_registry = registry.key();
        policy.max_per_transaction = 0;
        policy.session_budget_total = 0;
        policy.session_budget_remaining = 0;
        policy.approval_required_above = 0;
        policy.allowed_actions = ACTION_REQUEST_PAYMENT | ACTION_CREATE_ESCROW | ACTION_RELEASE_ESCROW;
        policy.version = 1;
        policy.bump = ctx.bumps.policy_vault;

        let reputation = &mut ctx.accounts.agent_reputation;
        reputation.agent_registry = registry.key();
        reputation.total_tasks_completed = 0;
        reputation.total_volume_minor = 0;
        reputation.bump = ctx.bumps.agent_reputation;

        emit!(AgentInitialized {
            owner: ctx.accounts.owner.key(),
            agent_registry: registry.key(),
        });

        Ok(())
    }

    pub fn set_policy(
        ctx: Context<SetPolicy>,
        max_per_transaction: u64,
        session_budget: u64,
        approval_required_above: u64,
        allowed_actions: u16,
    ) -> Result<()> {
        require!(
            max_per_transaction <= session_budget || session_budget == 0,
            AccuralError::InvalidPolicy
        );

        let policy = &mut ctx.accounts.policy_vault;
        policy.max_per_transaction = max_per_transaction;
        policy.session_budget_total = session_budget;
        policy.session_budget_remaining = session_budget;
        policy.approval_required_above = approval_required_above;
        policy.allowed_actions = allowed_actions;
        policy.version = policy
            .version
            .checked_add(1)
            .ok_or(AccuralError::MathOverflow)?;

        emit!(PolicyUpdated {
            agent_registry: ctx.accounts.agent_registry.key(),
            policy: policy.key(),
            max_per_transaction,
            session_budget,
            version: policy.version,
        });

        Ok(())
    }

    pub fn register_service(
        ctx: Context<RegisterService>,
        service_type: String,
        description: String,
        price_minor: u64,
    ) -> Result<()> {
        validate_id(&service_type, MAX_SERVICE_TYPE_LEN, AccuralError::InvalidServiceType)?;
        validate_text(&description, MAX_DESCRIPTION_LEN, AccuralError::DescriptionTooLong)?;

        let listing = &mut ctx.accounts.service_listing;
        listing.agent_registry = ctx.accounts.agent_registry.key();
        listing.service_type = service_type.clone();
        listing.description = description;
        listing.price_minor = price_minor;
        listing.mint = ctx.accounts.mint.key();
        listing.active = true;
        listing.bump = ctx.bumps.service_listing;

        emit!(ServiceRegistered {
            agent_registry: listing.agent_registry,
            service_listing: listing.key(),
            service_type,
        });

        Ok(())
    }

    pub fn deactivate_service(ctx: Context<DeactivateService>) -> Result<()> {
        let listing = &mut ctx.accounts.service_listing;
        listing.active = false;

        emit!(ServiceDeactivated {
            agent_registry: listing.agent_registry,
            service_listing: listing.key(),
            service_type: listing.service_type.clone(),
        });

        Ok(())
    }

    pub fn request_payment(
        ctx: Context<RequestPayment>,
        task_id: String,
        amount: u64,
        mint: Pubkey,
        recipient: Pubkey,
        purpose: String,
        expires_at: i64,
    ) -> Result<()> {
        validate_id(&task_id, MAX_TASK_ID_LEN, AccuralError::InvalidTaskId)?;
        validate_text(&purpose, MAX_PURPOSE_LEN, AccuralError::PurposeTooLong)?;
        require!(amount > 0, AccuralError::ZeroAmount);
        require!(
            expires_at > Clock::get()?.unix_timestamp,
            AccuralError::InvalidExpiry
        );

        let policy = &ctx.accounts.policy_vault;
        require_action(policy.allowed_actions, ACTION_REQUEST_PAYMENT)?;

        let intent = &mut ctx.accounts.payment_intent;
        intent.agent_registry = ctx.accounts.agent_registry.key();
        intent.task_id = task_id;
        intent.amount = amount;
        intent.mint = mint;
        intent.recipient = recipient;
        intent.purpose = purpose;
        intent.expires_at = expires_at;
        intent.status = PaymentIntentStatus::Requested;
        intent.bump = ctx.bumps.payment_intent;

        emit!(PaymentRequested {
            agent_registry: intent.agent_registry,
            payment_intent: intent.key(),
            task_id: intent.task_id.clone(),
            amount,
            mint,
            recipient,
            expires_at,
        });

        Ok(())
    }

    pub fn fund_escrow(
        ctx: Context<FundEscrow>,
        task_id: String,
        amount: u64,
        purpose: String,
        human_approved: bool,
    ) -> Result<()> {
        validate_id(&task_id, MAX_TASK_ID_LEN, AccuralError::InvalidTaskId)?;
        validate_text(&purpose, MAX_PURPOSE_LEN, AccuralError::PurposeTooLong)?;
        require!(amount > 0, AccuralError::ZeroAmount);

        let intent = &mut ctx.accounts.payment_intent;
        require!(
            intent.status == PaymentIntentStatus::Requested,
            AccuralError::PaymentIntentNotRequested
        );
        require!(
            intent.expires_at > Clock::get()?.unix_timestamp,
            AccuralError::PaymentIntentExpired
        );
        require!(
            intent.agent_registry == ctx.accounts.agent_registry.key()
                && intent.task_id == task_id
                && intent.amount == amount
                && intent.mint == ctx.accounts.mint.key()
                && intent.recipient == ctx.accounts.beneficiary.key()
                && intent.purpose == purpose,
            AccuralError::PaymentIntentMismatch
        );

        let policy = &mut ctx.accounts.policy_vault;
        require_action(policy.allowed_actions, ACTION_CREATE_ESCROW)?;
        require!(
            amount <= policy.max_per_transaction,
            AccuralError::ExceedsTransactionLimit
        );
        require!(
            amount <= policy.session_budget_remaining,
            AccuralError::ExceedsSessionBudget
        );
        require!(
            amount <= policy.approval_required_above || human_approved,
            AccuralError::ApprovalRequired
        );

        policy.session_budget_remaining = policy
            .session_budget_remaining
            .checked_sub(amount)
            .ok_or(AccuralError::MathOverflow)?;

        let escrow = &mut ctx.accounts.escrow_account;
        escrow.agent_registry = ctx.accounts.agent_registry.key();
        escrow.task_id = task_id;
        escrow.amount = amount;
        escrow.mint = ctx.accounts.mint.key();
        escrow.escrow_token_account = ctx.accounts.escrow_token_account.key();
        escrow.payment_intent = intent.key();
        escrow.beneficiary = ctx.accounts.beneficiary.key();
        escrow.verifier = ctx.accounts.verifier.key();
        escrow.policy_version = policy.version;
        escrow.status = EscrowStatus::Funded;
        escrow.bump = ctx.bumps.escrow_account;
        intent.status = PaymentIntentStatus::Escrowed;

        let cpi_accounts = Transfer {
            from: ctx.accounts.payer_token_account.to_account_info(),
            to: ctx.accounts.escrow_token_account.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        };
        token::transfer(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
            amount,
        )?;

        emit!(EscrowFunded {
            agent_registry: ctx.accounts.agent_registry.key(),
            escrow: escrow.key(),
            task_id: escrow.task_id.clone(),
            amount,
            beneficiary: escrow.beneficiary,
            verifier: escrow.verifier,
            policy_version: escrow.policy_version,
        });

        Ok(())
    }

    pub fn release_escrow(
        ctx: Context<ReleaseEscrow>,
        reconciliation_hash: [u8; 32],
        outcome_code: u16,
        proof_uri: String,
    ) -> Result<()> {
        validate_text(&proof_uri, MAX_PROOF_URI_LEN, AccuralError::ProofUriTooLong)?;

        let policy = &ctx.accounts.policy_vault;
        require_action(policy.allowed_actions, ACTION_RELEASE_ESCROW)?;

        let escrow = &mut ctx.accounts.escrow_account;
        require!(
            escrow.status == EscrowStatus::Funded,
            AccuralError::EscrowNotFunded
        );
        escrow.status = EscrowStatus::Released;
        ctx.accounts.payment_intent.status = PaymentIntentStatus::Paid;

        let agent_registry_key = escrow.agent_registry;
        let task_id_bytes = escrow.task_id.as_bytes();
        let signer_seeds: &[&[u8]] = &[
            b"escrow",
            agent_registry_key.as_ref(),
            task_id_bytes,
            &[escrow.bump],
        ];

        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_token_account.to_account_info(),
            to: ctx.accounts.beneficiary_token_account.to_account_info(),
            authority: escrow.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                &[signer_seeds],
            ),
            escrow.amount,
        )?;

        let receipt = &mut ctx.accounts.reconciliation_record;
        receipt.escrow = escrow.key();
        receipt.agent_registry = escrow.agent_registry;
        receipt.task_id = escrow.task_id.clone();
        receipt.amount = escrow.amount;
        receipt.mint = escrow.mint;
        receipt.beneficiary = escrow.beneficiary;
        receipt.verifier = escrow.verifier;
        receipt.policy_version = escrow.policy_version;
        receipt.reconciliation_hash = reconciliation_hash;
        receipt.outcome_code = outcome_code;
        receipt.proof_uri = proof_uri;
        receipt.bump = ctx.bumps.reconciliation_record;

        emit!(EscrowReleased {
            agent_registry: escrow.agent_registry,
            escrow: escrow.key(),
            task_id: escrow.task_id.clone(),
            amount: escrow.amount,
            beneficiary: escrow.beneficiary,
            verifier: escrow.verifier,
            reconciliation_hash,
        });

        let reputation = &mut ctx.accounts.agent_reputation;
        reputation.total_tasks_completed = reputation
            .total_tasks_completed
            .checked_add(1)
            .ok_or(AccuralError::MathOverflow)?;
        reputation.total_volume_minor = reputation
            .total_volume_minor
            .checked_add(escrow.amount)
            .ok_or(AccuralError::MathOverflow)?;

        Ok(())
    }

    pub fn cancel_payment_intent(ctx: Context<CancelPaymentIntent>) -> Result<()> {
        let intent = &mut ctx.accounts.payment_intent;
        require!(
            intent.status == PaymentIntentStatus::Requested,
            AccuralError::PaymentIntentNotRequested
        );
        intent.status = PaymentIntentStatus::Cancelled;
        
        emit!(PaymentCancelled {
            agent_registry: intent.agent_registry,
            payment_intent: intent.key(),
            task_id: intent.task_id.clone(),
        });

        Ok(())
    }

    pub fn refund_escrow(ctx: Context<RefundEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_account;
        require!(
            escrow.status == EscrowStatus::Funded,
            AccuralError::EscrowNotFunded
        );
        escrow.status = EscrowStatus::Refunded;
        
        ctx.accounts.payment_intent.status = PaymentIntentStatus::Cancelled;

        let agent_registry_key = escrow.agent_registry;
        let task_id_bytes = escrow.task_id.as_bytes();
        let signer_seeds: &[&[u8]] = &[
            b"escrow",
            agent_registry_key.as_ref(),
            task_id_bytes,
            &[escrow.bump],
        ];

        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_token_account.to_account_info(),
            to: ctx.accounts.payer_token_account.to_account_info(),
            authority: escrow.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                &[signer_seeds],
            ),
            escrow.amount,
        )?;

        emit!(EscrowRefunded {
            agent_registry: escrow.agent_registry,
            escrow: escrow.key(),
            task_id: escrow.task_id.clone(),
            amount: escrow.amount,
        });

        Ok(())
    }

    pub fn direct_payment(
        ctx: Context<DirectPayment>,
        task_id: String,
        amount: u64,
        purpose: String,
        reconciliation_hash: [u8; 32],
        proof_uri: String,
    ) -> Result<()> {
        validate_id(&task_id, MAX_TASK_ID_LEN, AccuralError::InvalidTaskId)?;
        validate_text(&purpose, MAX_PURPOSE_LEN, AccuralError::PurposeTooLong)?;
        validate_text(&proof_uri, MAX_PROOF_URI_LEN, AccuralError::ProofUriTooLong)?;
        require!(amount > 0, AccuralError::ZeroAmount);

        let policy = &mut ctx.accounts.policy_vault;
        require_action(policy.allowed_actions, ACTION_DIRECT_PAYMENT)?;
        require!(
            amount <= policy.max_per_transaction,
            AccuralError::ExceedsTransactionLimit
        );
        require!(
            amount <= policy.session_budget_remaining,
            AccuralError::ExceedsSessionBudget
        );
        require!(
            amount <= policy.approval_required_above,
            AccuralError::ApprovalRequired
        );

        policy.session_budget_remaining = policy
            .session_budget_remaining
            .checked_sub(amount)
            .ok_or(AccuralError::MathOverflow)?;

        let cpi_accounts = Transfer {
            from: ctx.accounts.payer_token_account.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        };
        token::transfer(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
            amount,
        )?;

        let receipt = &mut ctx.accounts.reconciliation_record;
        receipt.escrow = Pubkey::default();
        receipt.agent_registry = ctx.accounts.agent_registry.key();
        receipt.task_id = task_id.clone();
        receipt.amount = amount;
        receipt.mint = ctx.accounts.mint.key();
        receipt.beneficiary = ctx.accounts.recipient.key();
        receipt.verifier = Pubkey::default();
        receipt.policy_version = policy.version;
        receipt.reconciliation_hash = reconciliation_hash;
        receipt.outcome_code = 0;
        receipt.proof_uri = proof_uri;
        receipt.bump = ctx.bumps.reconciliation_record;

        emit!(DirectPaymentMade {
            agent_registry: receipt.agent_registry,
            task_id,
            amount,
            recipient: receipt.beneficiary,
            reconciliation_hash,
        });

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(agent_id: String)]
pub struct InitializeAgent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = AgentRegistry::LEN,
        seeds = [b"registry", owner.key().as_ref(), agent_id.as_bytes()],
        bump
    )]
    pub agent_registry: Account<'info, AgentRegistry>,

    #[account(
        init,
        payer = owner,
        space = PolicyVault::LEN,
        seeds = [b"policy", agent_registry.key().as_ref()],
        bump
    )]
    pub policy_vault: Account<'info, PolicyVault>,

    #[account(
        init,
        payer = owner,
        space = AgentReputation::LEN,
        seeds = [b"reputation", agent_registry.key().as_ref()],
        bump
    )]
    pub agent_reputation: Account<'info, AgentReputation>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPolicy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(has_one = owner)]
    pub agent_registry: Account<'info, AgentRegistry>,

    #[account(
        mut,
        seeds = [b"policy", agent_registry.key().as_ref()],
        bump = policy_vault.bump,
        constraint = policy_vault.agent_registry == agent_registry.key() @ AccuralError::InvalidPolicyVault
    )]
    pub policy_vault: Account<'info, PolicyVault>,
}

#[derive(Accounts)]
#[instruction(service_type: String)]
pub struct RegisterService<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(has_one = owner)]
    pub agent_registry: Box<Account<'info, AgentRegistry>>,

    #[account(
        init,
        payer = owner,
        space = ServiceListing::LEN,
        seeds = [b"service", agent_registry.key().as_ref(), service_type.as_bytes()],
        bump
    )]
    pub service_listing: Box<Account<'info, ServiceListing>>,

    pub mint: Box<Account<'info, Mint>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DeactivateService<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(has_one = owner)]
    pub agent_registry: Box<Account<'info, AgentRegistry>>,

    #[account(
        mut,
        seeds = [b"service", agent_registry.key().as_ref(), service_listing.service_type.as_bytes()],
        bump = service_listing.bump,
        constraint = service_listing.agent_registry == agent_registry.key() @ AccuralError::InvalidServiceListing
    )]
    pub service_listing: Box<Account<'info, ServiceListing>>,
}

#[derive(Accounts)]
#[instruction(task_id: String)]
pub struct RequestPayment<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(has_one = owner)]
    pub agent_registry: Box<Account<'info, AgentRegistry>>,

    #[account(
        seeds = [b"policy", agent_registry.key().as_ref()],
        bump = policy_vault.bump,
        constraint = policy_vault.agent_registry == agent_registry.key() @ AccuralError::InvalidPolicyVault
    )]
    pub policy_vault: Box<Account<'info, PolicyVault>>,

    #[account(
        init,
        payer = owner,
        space = PaymentIntent::LEN,
        seeds = [b"payment_intent", agent_registry.key().as_ref(), task_id.as_bytes()],
        bump
    )]
    pub payment_intent: Box<Account<'info, PaymentIntent>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(task_id: String)]
pub struct FundEscrow<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(has_one = owner)]
    pub agent_registry: Box<Account<'info, AgentRegistry>>,

    #[account(
        mut,
        seeds = [b"policy", agent_registry.key().as_ref()],
        bump = policy_vault.bump,
        constraint = policy_vault.agent_registry == agent_registry.key() @ AccuralError::InvalidPolicyVault
    )]
    pub policy_vault: Box<Account<'info, PolicyVault>>,

    #[account(
        mut,
        seeds = [b"payment_intent", agent_registry.key().as_ref(), task_id.as_bytes()],
        bump = payment_intent.bump,
        constraint = payment_intent.agent_registry == agent_registry.key() @ AccuralError::InvalidPaymentIntent
    )]
    pub payment_intent: Box<Account<'info, PaymentIntent>>,

    #[account(
        init,
        payer = owner,
        space = EscrowAccount::LEN,
        seeds = [b"escrow", agent_registry.key().as_ref(), task_id.as_bytes()],
        bump
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,

    #[account(
        mut,
        constraint = escrow_token_account.owner == escrow_account.key() @ AccuralError::InvalidTokenOwner,
        constraint = escrow_token_account.mint == mint.key() @ AccuralError::InvalidMint
    )]
    pub escrow_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = payer_token_account.owner == owner.key() @ AccuralError::InvalidTokenOwner,
        constraint = payer_token_account.mint == mint.key() @ AccuralError::InvalidMint
    )]
    pub payer_token_account: Box<Account<'info, TokenAccount>>,

    pub mint: Box<Account<'info, Mint>>,

    /// CHECK: The beneficiary is recorded and enforced through its token account on release.
    pub beneficiary: AccountInfo<'info>,
    /// CHECK: The verifier must sign release_escrow.
    pub verifier: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ReleaseEscrow<'info> {
    #[account(mut)]
    pub verifier: Signer<'info>,

    #[account(
        seeds = [b"policy", escrow_account.agent_registry.as_ref()],
        bump = policy_vault.bump,
        constraint = policy_vault.agent_registry == escrow_account.agent_registry @ AccuralError::InvalidPolicyVault
    )]
    pub policy_vault: Box<Account<'info, PolicyVault>>,

    #[account(
        mut,
        seeds = [b"reputation", escrow_account.agent_registry.as_ref()],
        bump = agent_reputation.bump,
        constraint = agent_reputation.agent_registry == escrow_account.agent_registry @ AccuralError::InvalidReputation
    )]
    pub agent_reputation: Box<Account<'info, AgentReputation>>,

    #[account(
        mut,
        address = escrow_account.payment_intent,
        constraint = payment_intent.agent_registry == escrow_account.agent_registry @ AccuralError::InvalidPaymentIntent
    )]
    pub payment_intent: Box<Account<'info, PaymentIntent>>,

    #[account(
        mut,
        has_one = verifier,
        seeds = [b"escrow", escrow_account.agent_registry.as_ref(), escrow_account.task_id.as_bytes()],
        bump = escrow_account.bump
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,

    #[account(
        mut,
        address = escrow_account.escrow_token_account,
        constraint = escrow_token_account.owner == escrow_account.key() @ AccuralError::InvalidTokenOwner,
        constraint = escrow_token_account.mint == escrow_account.mint @ AccuralError::InvalidMint
    )]
    pub escrow_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = beneficiary_token_account.owner == escrow_account.beneficiary @ AccuralError::InvalidBeneficiary,
        constraint = beneficiary_token_account.mint == escrow_account.mint @ AccuralError::InvalidMint
    )]
    pub beneficiary_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = verifier,
        space = ReconciliationRecord::LEN,
        seeds = [b"reconciliation", escrow_account.key().as_ref()],
        bump
    )]
    pub reconciliation_record: Box<Account<'info, ReconciliationRecord>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelPaymentIntent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(has_one = owner)]
    pub agent_registry: Box<Account<'info, AgentRegistry>>,

    #[account(
        mut,
        close = owner,
        seeds = [b"payment_intent", agent_registry.key().as_ref(), payment_intent.task_id.as_bytes()],
        bump = payment_intent.bump,
        constraint = payment_intent.agent_registry == agent_registry.key() @ AccuralError::InvalidPaymentIntent
    )]
    pub payment_intent: Box<Account<'info, PaymentIntent>>,
}

#[derive(Accounts)]
pub struct RefundEscrow<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(has_one = owner)]
    pub agent_registry: Box<Account<'info, AgentRegistry>>,

    #[account(
        mut,
        address = escrow_account.payment_intent,
    )]
    pub payment_intent: Box<Account<'info, PaymentIntent>>,

    #[account(
        mut,
        seeds = [b"escrow", agent_registry.key().as_ref(), escrow_account.task_id.as_bytes()],
        bump = escrow_account.bump,
        constraint = escrow_account.agent_registry == agent_registry.key() @ AccuralError::InvalidEscrow
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,

    #[account(
        mut,
        address = escrow_account.escrow_token_account,
    )]
    pub escrow_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = payer_token_account.owner == owner.key() @ AccuralError::InvalidTokenOwner,
        constraint = payer_token_account.mint == escrow_account.mint @ AccuralError::InvalidMint
    )]
    pub payer_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[account]
pub struct AgentRegistry {
    pub owner: Pubkey,
    pub agent_id: String,
    pub bump: u8,
}

impl AgentRegistry {
    pub const LEN: usize = 8 + 32 + 4 + MAX_AGENT_ID_LEN + 1;
}

#[account]
pub struct AgentReputation {
    pub agent_registry: Pubkey,
    pub total_tasks_completed: u64,
    pub total_volume_minor: u64,
    pub bump: u8,
}

impl AgentReputation {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 1;
}

#[account]
pub struct ServiceListing {
    pub agent_registry: Pubkey,
    pub service_type: String,
    pub description: String,
    pub price_minor: u64,
    pub mint: Pubkey,
    pub active: bool,
    pub bump: u8,
}

impl ServiceListing {
    pub const LEN: usize = 8 + 32 + 4 + MAX_SERVICE_TYPE_LEN + 4 + MAX_DESCRIPTION_LEN + 8 + 32 + 1 + 1;
}

#[account]
pub struct PolicyVault {
    pub agent_registry: Pubkey,
    pub max_per_transaction: u64,
    pub session_budget_total: u64,
    pub session_budget_remaining: u64,
    pub approval_required_above: u64,
    pub allowed_actions: u16,
    pub version: u64,
    pub bump: u8,
}

impl PolicyVault {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 8 + 8 + 2 + 8 + 1;
}

#[account]
pub struct PaymentIntent {
    pub agent_registry: Pubkey,
    pub task_id: String,
    pub amount: u64,
    pub mint: Pubkey,
    pub recipient: Pubkey,
    pub purpose: String,
    pub expires_at: i64,
    pub status: PaymentIntentStatus,
    pub bump: u8,
}

impl PaymentIntent {
    pub const LEN: usize = 8 + 32 + 4 + MAX_TASK_ID_LEN + 8 + 32 + 32 + 4 + MAX_PURPOSE_LEN + 8 + 1 + 1;
}

#[account]
pub struct EscrowAccount {
    pub agent_registry: Pubkey,
    pub task_id: String,
    pub amount: u64,
    pub mint: Pubkey,
    pub escrow_token_account: Pubkey,
    pub payment_intent: Pubkey,
    pub beneficiary: Pubkey,
    pub verifier: Pubkey,
    pub policy_version: u64,
    pub status: EscrowStatus,
    pub bump: u8,
}

impl EscrowAccount {
    pub const LEN: usize =
        8 + 32 + 4 + MAX_TASK_ID_LEN + 8 + 32 + 32 + 32 + 32 + 32 + 8 + 1 + 1;
}

#[account]
pub struct ReconciliationRecord {
    pub escrow: Pubkey,
    pub agent_registry: Pubkey,
    pub task_id: String,
    pub amount: u64,
    pub mint: Pubkey,
    pub beneficiary: Pubkey,
    pub verifier: Pubkey,
    pub policy_version: u64,
    pub reconciliation_hash: [u8; 32],
    pub outcome_code: u16,
    pub proof_uri: String,
    pub bump: u8,
}

impl ReconciliationRecord {
    pub const LEN: usize =
        8 + 32 + 32 + 4 + MAX_TASK_ID_LEN + 8 + 32 + 32 + 32 + 8 + 32 + 2 + 4 + MAX_PROOF_URI_LEN + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum PaymentIntentStatus {
    Requested,
    Escrowed,
    Paid,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum EscrowStatus {
    Funded,
    Released,
    Refunded,
}

#[event]
pub struct AgentInitialized {
    pub owner: Pubkey,
    pub agent_registry: Pubkey,
}

#[event]
pub struct PolicyUpdated {
    pub agent_registry: Pubkey,
    pub policy: Pubkey,
    pub max_per_transaction: u64,
    pub session_budget: u64,
    pub version: u64,
}

#[event]
pub struct ServiceRegistered {
    pub agent_registry: Pubkey,
    pub service_listing: Pubkey,
    pub service_type: String,
}

#[event]
pub struct ServiceDeactivated {
    pub agent_registry: Pubkey,
    pub service_listing: Pubkey,
    pub service_type: String,
}

#[event]
pub struct PaymentRequested {
    pub agent_registry: Pubkey,
    pub payment_intent: Pubkey,
    pub task_id: String,
    pub amount: u64,
    pub mint: Pubkey,
    pub recipient: Pubkey,
    pub expires_at: i64,
}

#[event]
pub struct EscrowFunded {
    pub agent_registry: Pubkey,
    pub escrow: Pubkey,
    pub task_id: String,
    pub amount: u64,
    pub beneficiary: Pubkey,
    pub verifier: Pubkey,
    pub policy_version: u64,
}

#[event]
pub struct EscrowReleased {
    pub agent_registry: Pubkey,
    pub escrow: Pubkey,
    pub task_id: String,
    pub amount: u64,
    pub beneficiary: Pubkey,
    pub verifier: Pubkey,
    pub reconciliation_hash: [u8; 32],
}

#[event]
pub struct PaymentCancelled {
    pub agent_registry: Pubkey,
    pub payment_intent: Pubkey,
    pub task_id: String,
}

#[event]
pub struct EscrowRefunded {
    pub agent_registry: Pubkey,
    pub escrow: Pubkey,
    pub task_id: String,
    pub amount: u64,
}

#[event]
pub struct DirectPaymentMade {
    pub agent_registry: Pubkey,
    pub task_id: String,
    pub amount: u64,
    pub recipient: Pubkey,
    pub reconciliation_hash: [u8; 32],
}

fn validate_id(value: &str, max_len: usize, error: AccuralError) -> Result<()> {
    if value.is_empty() || value.len() > max_len {
        return Err(error.into());
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(error.into());
    }
    Ok(())
}

fn validate_text(value: &str, max_len: usize, error: AccuralError) -> Result<()> {
    if value.is_empty() || value.len() > max_len {
        return Err(error.into());
    }
    Ok(())
}

fn require_action(mask: u16, action: u16) -> Result<()> {
    require!(mask & action == action, AccuralError::ActionNotAllowed);
    Ok(())
}

#[error_code]
pub enum AccuralError {
    #[msg("Agent id must be 1-32 ASCII characters: letters, numbers, dot, underscore, or hyphen")]
    InvalidAgentId,
    #[msg("Task id must be 1-32 ASCII characters: letters, numbers, dot, underscore, or hyphen")]
    InvalidTaskId,
    #[msg("Purpose is empty or too long")]
    PurposeTooLong,
    #[msg("Proof URI is empty or too long")]
    ProofUriTooLong,
    #[msg("Escrow amount must be greater than zero")]
    ZeroAmount,
    #[msg("Payment intent expiry must be in the future")]
    InvalidExpiry,
    #[msg("Invalid spend policy")]
    InvalidPolicy,
    #[msg("Policy vault does not belong to this agent")]
    InvalidPolicyVault,
    #[msg("Policy does not allow this action")]
    ActionNotAllowed,
    #[msg("Amount requires human approval under the current policy")]
    ApprovalRequired,
    #[msg("Amount exceeds maximum allowed per transaction")]
    ExceedsTransactionLimit,
    #[msg("Amount exceeds remaining session budget")]
    ExceedsSessionBudget,
    #[msg("Escrow is not in funded state")]
    EscrowNotFunded,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Token account owner is invalid")]
    InvalidTokenOwner,
    #[msg("Token account mint is invalid")]
    InvalidMint,
    #[msg("Beneficiary token account does not belong to escrow beneficiary")]
    InvalidBeneficiary,
    #[msg("Payment intent account is invalid")]
    InvalidPaymentIntent,
    #[msg("Payment intent is expired")]
    PaymentIntentExpired,
    #[msg("Payment intent is not in requested state")]
    PaymentIntentNotRequested,
    #[msg("Payment intent does not match escrow details")]
    PaymentIntentMismatch,
    #[msg("Escrow account is invalid")]
    InvalidEscrow,
    #[msg("Service type must be 1-32 ASCII characters")]
    InvalidServiceType,
    #[msg("Description is empty or too long")]
    DescriptionTooLong,
    #[msg("Service listing account is invalid")]
    InvalidServiceListing,
    #[msg("Agent reputation account is invalid")]
    InvalidReputation,
}
