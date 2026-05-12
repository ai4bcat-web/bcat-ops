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
      createdBy:       a.string().required(),
      updatedBy:       a.string().required(),
    })
    .authorization((allow) => [allow.authenticated()]),

  Driver: a
    .model({
      name:     a.string().required(),
      phone:    a.string().required(),
      active:   a.boolean().required(),
      type:     a.string(),
      colorKey: a.string(),
      notes:    a.string(),
    })
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

  // Admin-only: manage Cognito users via Lambda
  manageUsers: a
    .query()
    .arguments({
      action:   a.string().required(),
      email:    a.string(),
      username: a.string(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.group('ADMIN')])
    .handler(a.handler.function(userManagement)),
})

export type Schema = ClientSchema<typeof schema>

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
})
