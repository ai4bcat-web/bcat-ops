import { type ClientSchema, a, defineData } from '@aws-amplify/backend'
import { userManagement } from '../functions/userManagement/resource'

const schema = a.schema({
  Load: a
    .model({
      aljexId:         a.string().required(),
      tmsId:           a.string().required(),
      pickupNumber:    a.string().required(),
      originName:      a.string(),
      originCity:      a.string(),
      destinationName: a.string(),
      destinationCity: a.string(),
      pickupAppt:      a.string().required(),
      pickupApptEnd:   a.string(),
      pickupApptType:  a.string(),
      deliveryAppt:    a.string().required(),
      deliveryApptEnd: a.string(),
      deliveryApptType: a.string(),
      pickupDriverId:  a.string(),
      deliveryDriverId: a.string(),
      readyToInvoice:  a.boolean().required(),
      rateConfirmKey:  a.string(),
      truckId:         a.string(),
      rate:            a.integer(),
      miles:           a.integer(),
      customer:        a.string(),
      createdBy:       a.string().required(),
      updatedBy:       a.string().required(),
    })
    .authorization((allow) => [allow.authenticated()]),

  Driver: a
    .model({
      name:               a.string().required(),
      phone:              a.string().required(),
      active:             a.boolean().required(),
      type:               a.string(),
      colorKey:           a.string(),
      notes:              a.string(),
      photoKey:           a.string(),
      assignedTruckId:    a.string(),
      // Compliance & profile fields
      email:              a.string(),
      cdl:                a.string(),   // CDL number e.g. "CDL-A IL-8823901"
      cdlExpiration:      a.string(),   // YYYY-MM-DD
      medCardExpiration:  a.string(),   // YYYY-MM-DD
      drugTestDate:       a.string(),   // YYYY-MM-DD — last test date
      hireDate:           a.string(),   // YYYY-MM-DD
      driverType:         a.string(),   // 'company' | 'owner_op'
    })
    .authorization((allow) => [allow.authenticated()]),

  // ── Intake queue ──────────────────────────────────────────────────────────
  // Records created by the intake-webhook Lambda when Gmail forwards load emails.
  IntakeItem: a
    .model({
      source:               a.enum(['IVAN_CARTAGE', 'BCAT_LOGISTICS']),
      status:               a.enum(['NEED_TO_BUILD', 'BUILT']),
      assignedTo:           a.string(),        // email of the team member responsible
      receivedAt:           a.datetime(),
      fromEmail:            a.string(),
      subject:              a.string(),
      bodyText:             a.string(),
      bodyHtml:             a.string(),
      s3KeyPdfAttachments:  a.string().array(),
      gmailMessageId:       a.string(),        // deduplication key
      extractedMetadata:    a.json(),
      builtLoadId:          a.id(),
      notes:                a.string(),
    })
    .secondaryIndexes((index) => [
      index('assignedTo').sortKeys(['receivedAt']),
      index('source').sortKeys(['receivedAt']),
      index('gmailMessageId'),
    ])
    .authorization((allow) => [allow.authenticated()]),

  AuditLog: a
    .model({
      entityType: a.string().required(),
      entityId:   a.string().required(),
      action:     a.string().required(),
      user:       a.string().required(),
      changes:    a.json().required(),
    })
    .authorization((allow) => [
      allow.authenticated().to(['create', 'read']),
    ]),

  // Admin-only: manage Cognito users via Lambda.
  // Authorization is allow.authenticated() so the Lambda receives the call and can
  // inspect event.identity.claims.email — the Lambda throws for non-admin callers.
  // Client-side: isAdminEmail() in AuthContext gates the UI and the nav link.
  manageUsers: a
    .query()
    .arguments({
      action:   a.string().required(),
      email:    a.string(),
      username: a.string(),
      pages:    a.string(),
      isAdmin:  a.boolean(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(userManagement)),
})

export type Schema = ClientSchema<typeof schema>

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
})
