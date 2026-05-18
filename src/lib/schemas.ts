import { z } from 'zod'

export const driverSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z
    .string()
    .refine(
      (v) => v.replace(/\D/g, '').length >= 10,
      'Phone must contain at least 10 digits'
    ),
  active: z.boolean(),
  type: z.enum(['driver', 'broker']),
  colorKey: z.enum([
    'driver-1','driver-2','driver-3','driver-4','driver-5','driver-6',
    'driver-7','driver-8','driver-9','driver-10','driver-11','driver-12',
    'broker',
  ]).optional(),
  notes: z.string().optional(),
  // Compliance fields
  email: z.string().optional(),
  cdl: z.string().optional(),
  cdlExpiration: z.string().optional(),
  medCardExpiration: z.string().optional(),
  drugTestDate: z.string().optional(),
  hireDate: z.string().optional(),
  driverType: z.enum(['company', 'owner_op']).optional(),
})

const apptTypeEnum = z.enum(['exact', 'range', 'fcfs'])

export const loadSchema = z
  .object({
    aljexId: z.string().min(1, 'ALJEX ID is required'),
    tmsId: z.string().min(1, 'TMS ID / PO is required'),
    pickupNumber: z.string().min(1, 'PU# is required'),

    originName:      z.string().optional(),
    originCity:      z.string().optional(),
    destinationName: z.string().optional(),
    destinationCity: z.string().optional(),

    pickupApptType: apptTypeEnum,
    pickupAppt: z.string().min(1, 'Pickup appointment is required'),
    pickupApptEnd: z.string().optional(),

    deliveryApptType: apptTypeEnum,
    deliveryAppt: z.string().min(1, 'Delivery appointment is required'),
    deliveryApptEnd: z.string().optional(),

    pickupDriverId: z.string().nullable(),
    deliveryDriverId: z.string().nullable(),
    readyToInvoice: z.boolean(),
  })
  .refine(
    (d) => d.deliveryAppt >= d.pickupAppt,
    { message: 'Delivery must be on or after pickup', path: ['deliveryAppt'] }
  )
  .refine(
    (d) => d.pickupApptType !== 'range' || (!!d.pickupApptEnd && d.pickupApptEnd > d.pickupAppt),
    { message: 'Range end must be after start', path: ['pickupApptEnd'] }
  )
  .refine(
    (d) => d.deliveryApptType !== 'range' || (!!d.deliveryApptEnd && d.deliveryApptEnd > d.deliveryAppt),
    { message: 'Range end must be after start', path: ['deliveryApptEnd'] }
  )

export type DriverFormValues = z.infer<typeof driverSchema>
export type LoadFormValues = z.infer<typeof loadSchema>
