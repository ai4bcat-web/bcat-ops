// Phased onboarding templates. A template describes the ORDER and OWNERSHIP of work,
// grouped into phases; every entry references a requirement KEY from the catalog
// (src/lib/complianceRequirements.ts) — templates never redefine a requirement.
//
// Ownership vs. entity:
//   - `owner`  (DRIVER | OFFICE) = who is responsible / whether it shows in the driver portal.
//   - `entity` (DRIVER | TRUCK)  = which record the generated OnboardingTask lives on.
//     DRIVER-entity tasks are generated at kickoff. TRUCK-entity tasks are generated
//     against Driver.assignedTruckId once Phase 2 completes (see onboardingPhases.ts / #5).
//
// A single requirement key may appear in more than one phase (e.g. occ_acc_or_workers_comp
// is a driver-signed form in P1 and an office-obtained certificate in P2); tasks are keyed
// by (phase, requirementKey, entity), so these coexist without collision.

import type { DriverType } from './complianceRequirements'

export type TaskOwner = 'DRIVER' | 'OFFICE'

export interface TemplateEntry {
  /** Catalog requirement key — resolved via getRequirement(). */
  key: string
  owner: TaskOwner
  /** Overrides the catalog's requiresDocument when set (per-task file vs. checkbox). */
  requiresDocument?: boolean
  /** Include this entry only for the given driver type (omit = all types). */
  appliesToDriverType?: DriverType
  /** Due date = phase-start date + this many days (omit = no due date). */
  dueDaysFromPhaseStart?: number
  /** Record the task lives on. Default 'DRIVER'. 'TRUCK' tasks link to assignedTruckId. */
  entity?: 'DRIVER' | 'TRUCK'
}

export interface OnboardingPhase {
  phase: number
  title: string
  entries: TemplateEntry[]
}

export interface OnboardingTemplate {
  id: string
  label: string
  phases: OnboardingPhase[]
}

// ── Amazon Relay driver template ──────────────────────────────────────────────

export const AMAZON_DRIVER_TEMPLATE: OnboardingTemplate = {
  id: 'amazon-driver-v1',
  label: 'Amazon Relay Driver',
  phases: [
    {
      phase: 1,
      title: 'Application, Documents, MVR & Drug Test',
      entries: [
        { key: 'employment_application', owner: 'DRIVER', dueDaysFromPhaseStart: 3 },
        { key: 'cdl_copy', owner: 'DRIVER', requiresDocument: true, dueDaysFromPhaseStart: 3 },
        { key: 'medical_card', owner: 'DRIVER', requiresDocument: true, dueDaysFromPhaseStart: 5 },
        { key: 'identity_doc_ssc_passport', owner: 'DRIVER', requiresDocument: true, dueDaysFromPhaseStart: 5 },
        { key: 'mvr_drug_consent_form', owner: 'DRIVER', requiresDocument: true, dueDaysFromPhaseStart: 3 },
        { key: 'pre_employment_drug_test', owner: 'DRIVER', requiresDocument: false, dueDaysFromPhaseStart: 7 },
        { key: 'occ_acc_or_workers_comp', owner: 'DRIVER', requiresDocument: true, dueDaysFromPhaseStart: 7 },
        { key: 'amazon_relay_access', owner: 'OFFICE', requiresDocument: false },
        { key: 'amazon_relay_course', owner: 'DRIVER', requiresDocument: false, dueDaysFromPhaseStart: 7 },
        { key: 'mvr_initial', owner: 'OFFICE', requiresDocument: true },
        { key: 'med_examiner_registry_check', owner: 'OFFICE', requiresDocument: false },
        { key: 'clearinghouse_pre_employment', owner: 'OFFICE', requiresDocument: false },
      ],
    },
    {
      phase: 2,
      title: 'Lease & IRS',
      entries: [
        { key: 'lease_agreement', owner: 'DRIVER', requiresDocument: true },
        { key: 'i9_w4', owner: 'DRIVER', requiresDocument: true, appliesToDriverType: 'COMPANY' },
        { key: 'w9', owner: 'DRIVER', requiresDocument: true, appliesToDriverType: 'OWNER_OPERATOR' },
        { key: 'occ_acc_or_workers_comp', owner: 'OFFICE', requiresDocument: true },
      ],
    },
    {
      phase: 3,
      title: 'Truck, Permits & Insurance',
      entries: [
        // Driver-provided
        { key: 'oo_bobtail_insurance', owner: 'DRIVER', requiresDocument: true },
        { key: 'hvut_2290', owner: 'DRIVER', requiresDocument: true },
        { key: 'title_or_lease_proof', owner: 'DRIVER', requiresDocument: true },
        { key: 'uia_port_authority_driver', owner: 'OFFICE', requiresDocument: false },
        // Truck-owned (generated on the assigned truck once Phase 2 completes)
        { key: 'truck_title_registration', owner: 'OFFICE', requiresDocument: true, entity: 'TRUCK' },
        { key: 'irp_cab_card', owner: 'OFFICE', requiresDocument: true, entity: 'TRUCK' },
        { key: 'ifta_decals', owner: 'OFFICE', requiresDocument: true, entity: 'TRUCK' },
        { key: 'eld_installed', owner: 'OFFICE', requiresDocument: false, entity: 'TRUCK' },
        { key: 'fuel_card_assigned', owner: 'OFFICE', requiresDocument: false, entity: 'TRUCK' },
        { key: 'nm_permits', owner: 'OFFICE', requiresDocument: true, entity: 'TRUCK' },
        { key: 'uia_port_authority_truck', owner: 'OFFICE', requiresDocument: false, entity: 'TRUCK' },
        { key: 'cargo_insurance_add', owner: 'OFFICE', requiresDocument: true, entity: 'TRUCK' },
      ],
    },
    {
      phase: 4,
      title: 'Inspection & Relay',
      entries: [
        { key: 'annual_dot_inspection', owner: 'DRIVER', requiresDocument: true },
        { key: 'amazon_relay_truck', owner: 'OFFICE', requiresDocument: false, entity: 'TRUCK' },
        { key: 'amazon_relay_driver', owner: 'OFFICE', requiresDocument: false },
      ],
    },
  ],
}

// Registry of selectable templates (kickoff dialog reads this).
export const ONBOARDING_TEMPLATES: readonly OnboardingTemplate[] = [AMAZON_DRIVER_TEMPLATE]

export function getOnboardingTemplate(id: string): OnboardingTemplate | undefined {
  return ONBOARDING_TEMPLATES.find((t) => t.id === id)
}

/** Portal visibility follows ownership: only DRIVER-owned entries reach the driver portal. */
export function entryIsDriverVisible(entry: TemplateEntry): boolean {
  return entry.owner === 'DRIVER'
}

/** All entries for one entity ('DRIVER' | 'TRUCK') across the whole template, phase-tagged. */
export function templateEntriesForEntity(
  template: OnboardingTemplate,
  entity: 'DRIVER' | 'TRUCK',
): { phase: number; entry: TemplateEntry }[] {
  const out: { phase: number; entry: TemplateEntry }[] = []
  for (const p of template.phases) {
    for (const entry of p.entries) {
      if ((entry.entity ?? 'DRIVER') === entity) out.push({ phase: p.phase, entry })
    }
  }
  return out
}
