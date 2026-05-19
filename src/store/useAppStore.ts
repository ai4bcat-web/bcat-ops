import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Driver, Load, AuditLogEntry, ViewMode, EntityType, AuditAction } from '@/types'
import type { Equipment, MaintenanceTask, MaintenanceInvoice } from '@/types/equipment'
import type { Expense } from '@/types/expense'
import { getMondayOf } from '@/lib/date'
import * as api from '@/lib/apiClient'
import { errorMessage } from '@/lib/utils/errorMessage'

// ── Equipment seed data (imported from bcat-command-center PostgreSQL) ─────────
const SEED_EQUIPMENT: Equipment[] = [
  {
    id: 'eq-mnmpi9jxwd12', type: 'truck', unitNumber: '009', make: 'FREIGHTLINER', model: 'CASCADIA',
    year: 2012, plate: 'ANO4392', vin: '1FUJGLDR9CSBA3413', ownership: 'owned',
    insured: true, active: true, onTollwayAccount: false, fuelCardNumbers: ['00049'],
    dotInspectionDate: '2026-02-26', iftaExpirationDate: '2026-12-31', irpExpirationDate: '2026-12-31',
    insuranceExpirationDate: '2026-08-21', bobtailInsuranceDate: '2027-03-17',
    fleetManagerAssignee: 'ryne',
    createdAt: '2026-04-06T04:45:02Z', updatedAt: '2026-04-06T04:45:02Z',
  },
  {
    id: 'eq-mnevxuyoxpd8', type: 'truck', unitNumber: '299', make: 'FREIGHTLINER', model: 'CASCADIA',
    year: 2014, plate: 'P1343771', vin: '3AKJLGBG2ESFT2299', ownership: 'owned',
    insured: true, active: true, onTollwayAccount: true, fuelCardNumbers: ['00056'],
    dotInspectionDate: '2026-02-09', iftaExpirationDate: '2026-12-31', irpExpirationDate: '2027-03-31',
    insuranceExpirationDate: '2026-08-21',
    fleetManagerAssignee: 'ryne',
    createdAt: '2026-03-31T17:22:58Z', updatedAt: '2026-03-31T17:22:58Z',
  },
  {
    id: 'eq-mnevuhxgs5jf', type: 'truck', unitNumber: '530', make: 'VOLVO', model: 'VNL',
    year: 2018, plate: 'P1233771', vin: '4V4NC9EH8JN893530', ownership: 'financed',
    insured: true, active: true, onTollwayAccount: true, fuelCardNumbers: ['00031'],
    dotInspectionDate: '2026-01-31', iftaExpirationDate: '2026-12-31', irpExpirationDate: '2027-03-31',
    insuranceExpirationDate: '2026-08-21',
    fleetManagerAssignee: 'jason',
    createdAt: '2026-03-31T17:20:21Z', updatedAt: '2026-03-31T17:20:21Z',
  },
  {
    id: 'eq-mnevvq8q6tcx', type: 'truck', unitNumber: '685', make: 'VOLVO', model: 'VNL',
    year: 2018, plate: 'P1170810', vin: '4V4NC9EH0JN890685', ownership: 'financed',
    insured: true, active: true, onTollwayAccount: true, fuelCardNumbers: ['00007'],
    iftaExpirationDate: '2026-12-31', irpExpirationDate: '2027-03-31',
    insuranceExpirationDate: '2026-08-21',
    fleetManagerAssignee: 'jason',
    createdAt: '2026-03-31T17:21:18Z', updatedAt: '2026-03-31T17:21:18Z',
  },
  {
    id: 'eq-mnevwst30vwt', type: 'truck', unitNumber: '780', make: 'MACK', model: '',
    year: 2013, plate: 'P1170809', vin: '1M1AW02Y5DM034780', ownership: 'owned',
    insured: true, active: true, onTollwayAccount: true, fuelCardNumbers: ['00023'],
    dotInspectionDate: '2026-03-17', iftaExpirationDate: '2026-12-31', irpExpirationDate: '2027-03-31',
    insuranceExpirationDate: '2026-08-21',
    fleetManagerAssignee: 'jason',
    createdAt: '2026-03-31T17:22:09Z', updatedAt: '2026-03-31T17:22:09Z',
  },
  {
    id: 'eq-mnmpmycmsojj', type: 'truck', unitNumber: 'TBD', make: 'KENWORTH', model: 'T680',
    year: 2020, plate: 'AKC707', vin: '1XKYD49X7LJ427421', ownership: 'owned',
    insured: true, active: true, onTollwayAccount: false,
    dotInspectionDate: '2026-03-12', iftaExpirationDate: '2026-12-31', irpExpirationDate: '2026-12-31',
    insuranceExpirationDate: '2026-08-21', bobtailInsuranceDate: '2027-02-27',
    assignedDriverId: 'drv-mnh1puksmydo', fleetManagerAssignee: 'ryne',
    createdAt: '2026-04-06T04:48:41Z', updatedAt: '2026-04-06T04:48:41Z',
  },
  // ── Trailers ────────────────────────────────────────────────────────────────
  {
    id: 'eq-mnex02osubxo', type: 'trailer', unitNumber: '53103', make: 'UTILITY', model: '',
    year: 2021, plate: '1059202', vin: '1UYVS2531M3197801', ownership: 'owned',
    insured: false, active: true, onTollwayAccount: false,
    dotInspectionDate: '2026-03-01', irpExpirationDate: '2026-08-21',
    insuranceExpirationDate: '2026-08-21',
    fleetManagerAssignee: 'jason',
    createdAt: '2026-03-31T17:52:41Z', updatedAt: '2026-03-31T17:52:41Z',
  },
  {
    id: 'eq-mnewzfg20sho', type: 'trailer', unitNumber: '53105', make: 'UTILITY', model: '',
    year: 2021, plate: '778-AC-525', vin: '1UYVS2536M3197809', ownership: 'owned',
    insured: false, active: true, onTollwayAccount: false,
    dotInspectionDate: '2026-04-06',
    insuranceExpirationDate: '2026-08-21',
    fleetManagerAssignee: 'jason',
    createdAt: '2026-03-31T17:52:11Z', updatedAt: '2026-03-31T17:52:11Z',
  },
  {
    id: 'eq-mnew9mqmquur', type: 'trailer', unitNumber: '531375', make: 'HYUNDAI', model: '',
    year: 2015, plate: '539670ST', vin: '3H3V532C7FT313058', ownership: 'leased',
    insured: true, active: true, onTollwayAccount: true,
    dotInspectionDate: '2025-08-01',
    insuranceExpirationDate: '2026-08-21',
    fleetManagerAssignee: 'jason',
    createdAt: '2026-03-31T17:32:07Z', updatedAt: '2026-03-31T17:32:07Z',
  },
  {
    id: 'eq-mnewh0pwm7vt', type: 'trailer', unitNumber: '531386', make: 'GREAT DANE', model: '',
    year: 2015, plate: '532050ST', vin: '1GRAA0623FT605881', ownership: 'leased',
    insured: true, active: true, onTollwayAccount: true,
    dotInspectionDate: '2024-11-01',
    insuranceExpirationDate: '2026-08-21',
    fleetManagerAssignee: 'jason',
    createdAt: '2026-03-31T17:37:52Z', updatedAt: '2026-03-31T17:37:52Z',
  },
  {
    id: 'eq-mnewi3v8937x', type: 'trailer', unitNumber: '531388', make: 'GREAT DANE', model: '',
    year: 2015, plate: '532048ST', vin: '1GRAA0627FT605883', ownership: 'leased',
    insured: true, active: true, onTollwayAccount: true,
    dotInspectionDate: '2026-05-06',
    insuranceExpirationDate: '2026-08-21',
    fleetManagerAssignee: 'jason',
    createdAt: '2026-03-31T17:38:42Z', updatedAt: '2026-03-31T17:38:42Z',
  },
  {
    id: 'eq-mnewsbtqzn4b', type: 'trailer', unitNumber: '531389', make: 'GREAT DANE', model: '',
    year: 2015, plate: '532047ST', vin: '1GRAA0629FT605884', ownership: 'leased',
    insured: true, active: true, onTollwayAccount: true,
    dotInspectionDate: '2025-09-01',
    insuranceExpirationDate: '2026-08-21',
    fleetManagerAssignee: 'jason',
    createdAt: '2026-03-31T17:46:39Z', updatedAt: '2026-03-31T17:46:39Z',
  },
  {
    id: 'eq-mnewjegoteii', type: 'trailer', unitNumber: '531394', make: 'GREAT DANE', model: '',
    year: 2015, plate: '532104ST', vin: '1GRAA0628FT605889', ownership: 'leased',
    insured: true, active: true, onTollwayAccount: true,
    dotInspectionDate: '2025-10-01',
    insuranceExpirationDate: '2026-08-21',
    fleetManagerAssignee: 'jason',
    createdAt: '2026-03-31T17:39:43Z', updatedAt: '2026-03-31T17:39:43Z',
  },
  {
    id: 'eq-mnewwmcsjary', type: 'trailer', unitNumber: '5384', make: 'GREAT DANE', model: '',
    year: 2019, plate: '778-AC-522', vin: '4GRAA0623KB156797', ownership: 'owned',
    insured: true, active: true, onTollwayAccount: false,
    dotInspectionDate: '2026-03-01',
    insuranceExpirationDate: '2026-08-21',
    fleetManagerAssignee: 'jason',
    createdAt: '2026-03-31T17:50:00Z', updatedAt: '2026-03-31T17:50:00Z',
  },
  {
    id: 'eq-mnewyfmrxltl', type: 'trailer', unitNumber: '5389', make: 'GREAT DANE', model: '',
    year: 2019, plate: '778-AC-523', vin: '4GRAA0628LB175119', ownership: 'owned',
    insured: false, active: true, onTollwayAccount: false,
    insuranceExpirationDate: '2026-08-21',
    fleetManagerAssignee: 'jason',
    createdAt: '2026-03-31T17:51:24Z', updatedAt: '2026-03-31T17:51:24Z',
  },
  {
    id: 'eq-mnewvn8cag19', type: 'trailer', unitNumber: '5922', make: 'GREAT DANE', model: '',
    year: 2019, plate: '1059204', vin: '1GRAA0624KK145922', ownership: 'owned',
    insured: true, active: true, onTollwayAccount: false,
    dotInspectionDate: '2025-06-01',
    insuranceExpirationDate: '2026-08-21',
    fleetManagerAssignee: 'jason',
    createdAt: '2026-03-31T17:49:14Z', updatedAt: '2026-03-31T17:49:14Z',
  },
]

const SEED_TASKS: MaintenanceTask[] = [
  { id: 'dot-mnex6j2yyrwb', equipmentId: 'eq-mnewi3v8937x', title: 'DOT Inspection', dueDate: '2024-09-01', priority: 'high', status: 'complete', notes: 'Annual DOT inspection required.', autoDot: true, createdAt: '2026-03-31T17:57:42Z', updatedAt: '2026-03-31T17:57:42Z' },
  { id: 'dot-mnex6j2yilho', equipmentId: 'eq-mnewh0pwm7vt', title: 'DOT Inspection', dueDate: '2025-11-01', priority: 'high', status: 'upcoming', notes: 'Annual DOT inspection required.', autoDot: true, createdAt: '2026-03-31T17:57:42Z', updatedAt: '2026-03-31T17:57:42Z' },
  { id: 'dot-mnew8skz0l83', equipmentId: 'eq-mnevuhxgs5jf', title: 'DOT Inspection', dueDate: '2026-03-31', priority: 'high', status: 'complete', notes: 'Annual DOT inspection required.', autoDot: true, createdAt: '2026-03-31T17:31:28Z', updatedAt: '2026-03-31T17:31:28Z' },
  { id: 'dot-mnew8skzkf2k', equipmentId: 'eq-mnevvq8q6tcx', title: 'DOT Inspection', dueDate: '2026-03-31', priority: 'high', status: 'upcoming', notes: 'Annual DOT inspection required.', autoDot: true, createdAt: '2026-03-31T17:31:28Z', updatedAt: '2026-03-31T17:31:28Z' },
  { id: 'dot-mnex6j2y129j', equipmentId: 'eq-mnewyfmrxltl', title: 'DOT Inspection', dueDate: '2026-03-31', priority: 'high', status: 'upcoming', notes: 'Annual DOT inspection required.', autoDot: true, createdAt: '2026-03-31T17:57:42Z', updatedAt: '2026-03-31T17:57:42Z' },
  { id: 'mt-mnnxh4pm5ysa', equipmentId: 'eq-mnewwmcsjary', title: 'Floor', dueDate: '2026-04-07', priority: 'high', status: 'complete', notes: 'Hole in floor and cracks where light shines thru', autoDot: false, assignee: 'Jason', createdAt: '2026-04-07T01:15:52Z', updatedAt: '2026-04-07T01:15:52Z' },
  { id: 'mt-mnhkq8t3i3dq', equipmentId: 'eq-mnevvq8q6tcx', title: 'PM/WIPERS/', dueDate: '2026-04-09', priority: 'high', status: 'complete', notes: "Pm close. Need wipers, scr aftertreatment message comes up. This morning, pulling out of batory, it wouldn't go over 5 mpg. I turned the engine off and restarted it and it's running fine. I think the sensor is bad. Also, I lose air pretty fast when I kill the engine. Just an fyi", autoDot: false, createdAt: '2026-04-02T14:32:25Z', updatedAt: '2026-04-02T14:32:25Z' },
  { id: 'mt-mnonronudkel', equipmentId: 'eq-mnevvq8q6tcx', title: 'Derate', dueDate: '2026-04-10', priority: 'high', status: 'complete', notes: 'Truck is derating and losing power', autoDot: false, assignee: 'Jason', createdAt: '2026-04-07T13:31:55Z', updatedAt: '2026-04-07T13:31:55Z' },
  { id: 'mt-mnogga8boqxi', equipmentId: 'eq-mnevuhxgs5jf', title: 'Grab these', dueDate: '2026-04-10', priority: 'high', status: 'complete', notes: 'Need power steering fluid dexron 2 or 3 needs a new air filter wiper blades', autoDot: false, assignee: 'Jason', createdAt: '2026-04-07T10:07:06Z', updatedAt: '2026-04-07T10:07:06Z' },
  { id: 'mt-mnmjf7kuba97', equipmentId: 'eq-mnewzfg20sho', title: 'insurance', dueDate: '2026-04-10', priority: 'high', status: 'complete', notes: 'needs to be added to insurance', autoDot: false, assignee: 'Ryne', createdAt: '2026-04-06T01:54:42Z', updatedAt: '2026-04-06T01:54:42Z' },
  { id: 'mt-mnmj264v2kdm', equipmentId: 'eq-mnewvn8cag19', title: 'floor', dueDate: '2026-04-14', priority: 'high', status: 'complete', notes: "there's some light coming through the floorboards near the rear of the trailer needs to be sealed up to prevent load rejection and leaks\nNew update theres a hole in the floor needs replaced", autoDot: false, assignee: 'Jason', createdAt: '2026-04-06T01:44:33Z', updatedAt: '2026-04-06T01:44:33Z' },
  { id: 'mt-mntdojs4lms7', equipmentId: 'eq-mnewh0pwm7vt', title: 'Tandem pin', dueDate: '2026-04-17', priority: 'med', status: 'complete', notes: '2 front tandem pins wont pull in to allow the rail to slide the tandems', autoDot: false, assignee: 'Jason', createdAt: '2026-04-10T20:48:23Z', updatedAt: '2026-04-10T20:48:23Z' },
  { id: 'mt-mnmj3gisgclx', equipmentId: 'eq-mnewvn8cag19', title: 'plate', dueDate: '2026-04-17', priority: 'high', status: 'complete', notes: 'need to swap out the plate with new temp plate', autoDot: false, assignee: 'Jason', createdAt: '2026-04-06T01:45:35Z', updatedAt: '2026-04-06T01:45:35Z' },
  { id: 'mt-mnonxk1vazav', equipmentId: 'eq-mnevvq8q6tcx', title: 'Check engine light', dueDate: '2026-04-17', priority: 'med', status: 'complete', notes: 'Code\nspn-5747 aftertreatment soot heater\nSpn-37 transmission air tank pressure\nSpn-4364 aftertreatment 1 scr conversion efficiency', autoDot: false, assignee: 'Jason', createdAt: '2026-04-07T13:36:29Z', updatedAt: '2026-04-07T13:36:29Z' },
  { id: 'mt-mnmilf7upo8t', equipmentId: 'eq-mnewi3v8937x', title: 'abs light', dueDate: '2026-04-17', priority: 'high', status: 'complete', notes: 'abs light comes on and off possible check for faulty abs issue as well as replacing abs light\nD.O.T violation', autoDot: false, createdAt: '2026-04-06T01:31:32Z', updatedAt: '2026-04-06T01:31:32Z' },
  { id: 'mt-mo5h5brcjdh1', equipmentId: 'eq-mnewvn8cag19', title: 'Mudflap', dueDate: '2026-04-18', priority: 'high', status: 'complete', notes: 'Left mudflap bracket bent and mudflap broke off', autoDot: false, assignee: 'Jason', createdAt: '2026-04-19T07:58:39Z', updatedAt: '2026-04-19T07:58:39Z' },
  { id: 'mt-mnmldgatsz6e', equipmentId: 'eq-mnevuhxgs5jf', title: 'phase 1', dueDate: '2026-04-18', priority: 'high', status: 'complete', notes: 'finish brake chamber on right rear axle than replace all slack adjusters on the right side', autoDot: false, assignee: 'Jason', createdAt: '2026-04-06T02:49:20Z', updatedAt: '2026-04-06T02:49:20Z' },
  { id: 'mt-mo5hdl8schq0', equipmentId: 'eq-mnevwst30vwt', title: 'Check engine light', dueDate: '2026-04-20', priority: 'high', status: 'complete', notes: 'Engine Exhaust Gas Recirculation 1\nDifferential Pressure\nFault Code SPN-411\nTake truck to brothers to get fixed for derate', autoDot: false, assignee: 'Jason', createdAt: '2026-04-19T08:05:05Z', updatedAt: '2026-04-19T08:05:05Z' },
  { id: 'mt-moaj65h71z6x', equipmentId: 'eq-mnewh0pwm7vt', title: 'Landing gear', dueDate: '2026-04-25', priority: 'med', status: 'upcoming', notes: 'Lube landing gear hard to rotate and change out a handle', autoDot: false, assignee: 'Jason', createdAt: '2026-04-22T20:54:07Z', updatedAt: '2026-04-22T20:54:07Z' },
  { id: 'mt-mnmj7dqc0cj9', equipmentId: 'eq-mnewwmcsjary', title: 'airbag', dueDate: '2026-04-25', priority: 'high', status: 'upcoming', notes: 'left rear axle airbag needs replaced audible leak p/n C-34733', autoDot: false, createdAt: '2026-04-06T01:48:37Z', updatedAt: '2026-04-06T01:48:37Z' },
  { id: 'mt-mnmjhltn0svt', equipmentId: 'eq-mnewzfg20sho', title: 'gladhand', dueDate: '2026-04-25', priority: 'med', status: 'upcoming', notes: 'emergency gladhand loose and needs to be replaced', autoDot: false, createdAt: '2026-04-06T01:56:34Z', updatedAt: '2026-04-06T01:56:34Z' },
  { id: 'mt-mnmi7ekicnp2', equipmentId: 'eq-mnewi3v8937x', title: 'crossmember', dueDate: '2026-04-30', priority: 'high', status: 'upcoming', notes: 'bent crossmember by the front driver side tires dot violation', autoDot: false, createdAt: '2026-04-06T01:20:38Z', updatedAt: '2026-04-06T01:20:38Z' },
  { id: 'mt-mnmiyhbmpfv5', equipmentId: 'eq-mnewh0pwm7vt', title: 'doors', dueDate: '2026-04-30', priority: 'med', status: 'upcoming', notes: 'door seals need to be replaced some spots are corroded and some spots missing seal needs replacing to prevent leaks inside the trailer', autoDot: false, createdAt: '2026-04-06T01:41:42Z', updatedAt: '2026-04-06T01:41:42Z' },
  { id: 'mt-mnmj01vsjw59', equipmentId: 'eq-mnewvn8cag19', title: 'alignment', dueDate: '2026-04-30', priority: 'med', status: 'upcoming', notes: 'needs alignment tracks to the left', autoDot: false, createdAt: '2026-04-06T01:42:55Z', updatedAt: '2026-04-06T01:42:55Z' },
  { id: 'mt-mo0vx7113jiq', equipmentId: 'eq-mnevwst30vwt', title: 'Check engine light', dueDate: '2026-04-30', priority: 'med', status: 'complete', notes: 'Check engine light for\nCodeSPN-411\nEngine Exhaust Gas Recirculation 1 Differential Pressure', autoDot: false, assignee: 'Jason', createdAt: '2026-04-16T02:53:23Z', updatedAt: '2026-04-16T02:53:23Z' },
  { id: 'mt-mnmlmyngrmlq', equipmentId: 'eq-mnevuhxgs5jf', title: 'air leak', dueDate: '2026-04-30', priority: 'high', status: 'complete', notes: 'audible air leak needs to be located and repaired D.O.T violation along with steady air leak while driving psi has a hard time goin above 100', autoDot: false, assignee: 'Jason', createdAt: '2026-04-06T02:56:43Z', updatedAt: '2026-04-06T02:56:43Z' },
  { id: 'mt-mnml1ooo6t9v', equipmentId: 'eq-mnevwst30vwt', title: 'electrical', dueDate: '2026-04-30', priority: 'med', status: 'upcoming', notes: 'dash lights go bright and cant be dimmed and when that happens lose power to the power window on the passenger side from the passenger switch and lose power to the power mirrors', autoDot: false, createdAt: '2026-04-06T02:40:11Z', updatedAt: '2026-04-06T02:40:11Z' },
  { id: 'mt-mnmi0l9fiseo', equipmentId: 'eq-mnewi3v8937x', title: 'alignment', dueDate: '2026-04-30', priority: 'med', status: 'upcoming', notes: 'needs alignment tracks to the right', autoDot: false, createdAt: '2026-04-06T01:15:20Z', updatedAt: '2026-04-06T01:15:20Z' },
  { id: 'mt-mnmhzixkr2wa', equipmentId: 'eq-mnewi3v8937x', title: 'registration paper', dueDate: '2026-04-30', priority: 'high', status: 'upcoming', notes: 'needs new registration paper from rental place', autoDot: false, createdAt: '2026-04-06T01:14:31Z', updatedAt: '2026-04-06T01:14:31Z' },
  { id: 'mt-mnmhxtr9v973', equipmentId: 'eq-mnew9mqmquur', title: 'brake fitting and hoses', dueDate: '2026-04-30', priority: 'med', status: 'complete', notes: 'all brake chamber hoses and fittings need to be looked over and replaced if worn or damaged', autoDot: false, createdAt: '2026-04-06T01:13:11Z', updatedAt: '2026-04-06T01:13:11Z' },
  { id: 'mt-mnminvuq7je2', equipmentId: 'eq-mnewi3v8937x', title: 'lube chassis', dueDate: '2026-04-30', priority: 'low', status: 'complete', notes: 'lube landing gear and chassis', autoDot: false, createdAt: '2026-04-06T01:33:27Z', updatedAt: '2026-04-06T01:33:27Z' },
  { id: 'mt-mo0vtck7te9l', equipmentId: 'eq-mnew9mqmquur', title: 'Swap out', dueDate: '2026-04-30', priority: 'med', status: 'upcoming', notes: 'Trailer repairs are too costly cheaper to replace woth newer trailer', autoDot: false, assignee: 'Jason', createdAt: '2026-04-16T02:50:23Z', updatedAt: '2026-04-16T02:50:23Z' },
  { id: 'mt-mo0vk9e64luo', equipmentId: 'eq-mnew9mqmquur', title: '2 tires', dueDate: '2026-04-30', priority: 'high', status: 'upcoming', notes: '2 left rear axle tires have 2 low spots', autoDot: false, assignee: 'Jason', createdAt: '2026-04-16T02:43:19Z', updatedAt: '2026-04-16T02:43:19Z' },
  { id: 'mt-mnmljkapj0tb', equipmentId: 'eq-mnevuhxgs5jf', title: 'phase 2', dueDate: '2026-04-30', priority: 'high', status: 'upcoming', notes: '6 brake drums\n6 brake shoes', autoDot: false, assignee: 'Jason', createdAt: '2026-04-06T02:54:05Z', updatedAt: '2026-04-06T02:54:05Z' },
  { id: 'mt-mnmm0fdvko2u', equipmentId: 'eq-mnewjegoteii', title: 'leaking', dueDate: '2026-04-30', priority: 'high', status: 'upcoming', notes: 'water leaking around the roof somewhere', autoDot: false, createdAt: '2026-04-06T03:07:11Z', updatedAt: '2026-04-06T03:07:11Z' },
  { id: 'mt-mnmhnebyhcv0', equipmentId: 'eq-mnew9mqmquur', title: 'front panel', dueDate: '2026-05-01', priority: 'med', status: 'upcoming', notes: 'needs front panel replaced due to rusting rivets causing panels to detach from the trailer frame possible cause for leaks in the front of the trailer.', autoDot: false, createdAt: '2026-04-06T01:05:05Z', updatedAt: '2026-04-06T01:05:05Z' },
  { id: 'mt-mnnxdfq347j8', equipmentId: 'eq-mnevuhxgs5jf', title: 'Check engine light', dueDate: '2026-05-02', priority: 'med', status: 'complete', notes: 'Codes spn-4364 scr efficiency aftertreatment 1\nSpn-1067 brake signal sensor 1\nSpn-794 abs sensor right 3rd axle\nSpn-647 fan clutch output driver', autoDot: false, assignee: 'Jason', createdAt: '2026-04-07T01:13:00Z', updatedAt: '2026-04-07T01:13:00Z' },
  { id: 'mt-mnmlh7y6wiw3', equipmentId: 'eq-mnevuhxgs5jf', title: 'phase 3', dueDate: '2026-05-09', priority: 'med', status: 'upcoming', notes: 'all 4 airbags dry rotted and in need of replacement as well as cab shocks and check cab airbag', autoDot: false, assignee: 'Jason', createdAt: '2026-04-06T02:52:15Z', updatedAt: '2026-04-06T02:52:15Z' },
  { id: 'mt-mp2syy00gzgo', equipmentId: 'eq-mnmpi9jxwd12', title: 'Fittings and hoses', dueDate: '2026-05-16', priority: 'med', status: 'upcoming', notes: 'All brake fittings to chambers and couple hoses need to be replaced', autoDot: false, assignee: 'Jason', createdAt: '2026-05-12T15:46:04Z', updatedAt: '2026-05-12T15:46:04Z' },
  { id: 'mt-mp2sz0wtp4fq', equipmentId: 'eq-mnmpi9jxwd12', title: 'Fittings and hoses', dueDate: '2026-05-16', priority: 'med', status: 'upcoming', notes: 'All brake fittings to chambers and couple hoses need to be replaced', autoDot: false, assignee: 'Jason', createdAt: '2026-05-12T15:46:05Z', updatedAt: '2026-05-12T15:46:05Z' },
  { id: 'mt-mp2t0aoqce3t', equipmentId: 'eq-mnewsbtqzn4b', title: 'Small belly spring', dueDate: '2026-05-16', priority: 'med', status: 'complete', notes: 'Small belly spring needs to b replaced that holds air lines up by the tank and plastic hose seperators need to b added in spots', autoDot: false, assignee: 'Jason', createdAt: '2026-05-12T15:47:03Z', updatedAt: '2026-05-12T15:47:03Z' },
  { id: 'mt-mnmkruy4440f', equipmentId: 'eq-mnewsbtqzn4b', title: 'brake chambers', dueDate: '2026-05-23', priority: 'med', status: 'complete', notes: 'needs 4 brake chambers replaced to prevent future issues', autoDot: false, assignee: 'Jason', createdAt: '2026-04-06T02:32:32Z', updatedAt: '2026-04-06T02:32:32Z' },
  { id: 'mt-mp2t2onyv7k9', equipmentId: 'eq-mnewsbtqzn4b', title: 'Air bags', dueDate: '2026-05-23', priority: 'med', status: 'complete', notes: '4 airbags need to be replaced cord is coming apart on the bottom of the bags', autoDot: false, assignee: 'Jason', createdAt: '2026-05-12T15:48:55Z', updatedAt: '2026-05-12T15:48:55Z' },
  { id: 'mt-moajdfn8k9fg', equipmentId: 'eq-mnevuhxgs5jf', title: 'Transmission', dueDate: '2026-05-30', priority: 'high', status: 'upcoming', notes: 'Check transmission message pops up could be related to steady airleak\nUpdate message checked out shop believes it to be a solenoid need to take back to shop for repair', autoDot: false, assignee: 'Jason', createdAt: '2026-04-22T20:59:47Z', updatedAt: '2026-04-22T20:59:47Z' },
  { id: 'mt-mnmiqon571rc', equipmentId: 'eq-mnewjegoteii', title: 'air tank', dueDate: '2026-05-30', priority: 'low', status: 'upcoming', notes: 'air tank rusted out will cause air leak if not replaced (preventative maintenance)', autoDot: false, createdAt: '2026-04-06T01:35:38Z', updatedAt: '2026-04-06T01:35:38Z' },
  { id: 'mt-mnmirw98w1a3', equipmentId: 'eq-mnewjegoteii', title: 'brake chambers', dueDate: '2026-05-30', priority: 'low', status: 'upcoming', notes: 'needs 2 brake chambers replaced', autoDot: false, createdAt: '2026-04-06T01:36:34Z', updatedAt: '2026-04-06T01:36:34Z' },
  { id: 'mt-mnmkyu2x77cd', equipmentId: 'eq-mnevvq8q6tcx', title: 'air leak', dueDate: '2026-05-30', priority: 'high', status: 'upcoming', notes: 'when shutting the truck off it sounds like air is still being pushed into the air tanks and truck loses all its air in the transmission within a short period\nUpdate\nShop checked it out needs transmission repairs', autoDot: false, assignee: 'Jason', createdAt: '2026-04-06T02:37:58Z', updatedAt: '2026-04-06T02:37:58Z' },
  { id: 'mt-mns6fa328vay', equipmentId: 'eq-mnew9mqmquur', title: 'brakes', dueDate: '2026-05-30', priority: 'med', status: 'upcoming', notes: 'needs 4 new brake shoes and possibly 4 drums have jamie check to see if they need drums or not wheels roll even when brakes engaged', autoDot: false, assignee: 'Jason', createdAt: '2026-04-10T00:37:27Z', updatedAt: '2026-04-10T00:37:27Z' },
  { id: 'mt-mnmhvd4alha5', equipmentId: 'eq-mnew9mqmquur', title: 'doors', dueDate: '2026-05-31', priority: 'low', status: 'upcoming', notes: 'both trailer doors are warped and dont close properly replace both doors to prevent leaks in the back and proper functionality of the doors.', autoDot: false, createdAt: '2026-04-06T01:11:17Z', updatedAt: '2026-04-06T01:11:17Z' },
  { id: 'mt-mnmloty7e5un', equipmentId: 'eq-mnevuhxgs5jf', title: 'tires', dueDate: '2026-05-31', priority: 'med', status: 'upcoming', notes: 'first drive axle tires need to be replaced various issues for concern of replacement as well as tread depth getting low', autoDot: false, createdAt: '2026-04-06T02:58:10Z', updatedAt: '2026-04-06T02:58:10Z' },
  { id: 'mt-mnmjmryf02cm', equipmentId: 'eq-mnex02osubxo', title: 'lube chassis', dueDate: '2026-05-31', priority: 'low', status: 'complete', notes: 'lube up landing gear and chassis', autoDot: false, createdAt: '2026-04-06T02:00:35Z', updatedAt: '2026-04-06T02:00:35Z' },
  { id: 'mt-mnml848dc0qy', equipmentId: 'eq-mnevwst30vwt', title: 'air leak', dueDate: '2026-05-31', priority: 'high', status: 'upcoming', notes: 'air leak from a fitting underneath the cat walk audible leak D.O.T violation', autoDot: false, createdAt: '2026-04-06T02:45:11Z', updatedAt: '2026-04-06T02:45:11Z' },
  { id: 'mt-mnml591i48te', equipmentId: 'eq-mnevwst30vwt', title: 'mirrors', dueDate: '2026-05-31', priority: 'med', status: 'upcoming', notes: 'heated mirrors on both sides dont work and the back cover is missing on the passenger side mirror\nbest to replace both mirrors', autoDot: false, createdAt: '2026-04-06T02:42:57Z', updatedAt: '2026-04-06T02:42:57Z' },
  { id: 'mt-mnmjt7b3fdr2', equipmentId: 'eq-mnex02osubxo', title: 'air tank', dueDate: '2026-05-31', priority: 'med', status: 'upcoming', notes: 'air tank is rusted out and needs to be replaced to prevent further issues with leaks', autoDot: false, createdAt: '2026-04-06T02:05:35Z', updatedAt: '2026-04-06T02:05:35Z' },
  { id: 'mt-mou994hiwodo', equipmentId: 'eq-mnewi3v8937x', title: 'Dock lock', dueDate: '2026-05-31', priority: 'med', status: 'complete', notes: 'Dock lock bar is broken needs to be replaced', autoDot: false, assignee: 'Jason', createdAt: '2026-05-06T16:11:54Z', updatedAt: '2026-05-06T16:11:54Z' },
  { id: 'mt-mnmj8lo7wfq1', equipmentId: 'eq-mnewwmcsjary', title: 'air tank', dueDate: '2026-05-31', priority: 'low', status: 'upcoming', notes: 'air tank is rusting out needs to be replaced to prevent future issues with air leaks', autoDot: false, createdAt: '2026-04-06T01:49:34Z', updatedAt: '2026-04-06T01:49:34Z' },
  { id: 'mt-mnmiuv2qe6t8', equipmentId: 'eq-mnewh0pwm7vt', title: 'dock lock', dueDate: '2026-05-31', priority: 'med', status: 'upcoming', notes: 'left dock lock plate is bent and smashed in where the dock lock arm rests', autoDot: false, createdAt: '2026-04-06T01:38:53Z', updatedAt: '2026-04-06T01:38:53Z' },
  { id: 'mt-mnmiit98bjy6', equipmentId: 'eq-mnewi3v8937x', title: 'tires', dueDate: '2026-05-31', priority: 'low', status: 'upcoming', notes: 'tires 12,13,14,16 need replaced after visual inspections were done on them due to potential hazards they could cause', autoDot: false, createdAt: '2026-04-06T01:29:30Z', updatedAt: '2026-04-06T01:29:30Z' },
  { id: 'mt-mnnx3ws52sva', equipmentId: 'eq-mnevuhxgs5jf', title: 'Alignment', dueDate: '2026-05-31', priority: 'med', status: 'upcoming', notes: 'Truck pulls to the right needs an alignment checked', autoDot: false, assignee: 'Jason', createdAt: '2026-04-07T01:05:37Z', updatedAt: '2026-04-07T01:05:37Z' },
  { id: 'mt-moajc10o8i00', equipmentId: 'eq-mnevuhxgs5jf', title: 'Electrical issues', dueDate: '2026-05-31', priority: 'med', status: 'upcoming', notes: 'Wiper switch possibly change wipers will only work on continuous and will stop intermedietly\nPossibly change out window switch for mirrors they will work left to right but sometimes wont go up and down', autoDot: false, assignee: 'Jason', createdAt: '2026-04-22T20:58:42Z', updatedAt: '2026-04-22T20:58:42Z' },
  { id: 'mt-mnmkqkw792y8', equipmentId: 'eq-mnewsbtqzn4b', title: 'air tank', dueDate: '2026-06-30', priority: 'low', status: 'complete', notes: 'air tank needs to be replaced due to it being rusted and to prevent future complications', autoDot: false, createdAt: '2026-04-06T02:31:32Z', updatedAt: '2026-04-06T02:31:32Z' },
  { id: 'mt-mnnxihd6tjrd', equipmentId: 'eq-mnewwmcsjary', title: 'Brake chamber', dueDate: '2026-06-30', priority: 'low', status: 'upcoming', notes: 'For preventative maint recommend 4 chambers', autoDot: false, assignee: 'Jason', createdAt: '2026-04-07T01:16:55Z', updatedAt: '2026-04-07T01:16:55Z' },
  { id: 'mt-mnmkm9ihacaa', equipmentId: 'eq-mnex02osubxo', title: 'brake chambers', dueDate: '2026-06-30', priority: 'low', status: 'upcoming', notes: 'replace 4 brake chambers to prevent future issues', autoDot: false, createdAt: '2026-04-06T02:28:11Z', updatedAt: '2026-04-06T02:28:11Z' },
  { id: 'mt-mnmkkzxe0fzb', equipmentId: 'eq-mnex02osubxo', title: 'tires', dueDate: '2026-06-30', priority: 'low', status: 'upcoming', notes: 'upon inspection tires 11,14,18 looked to be the ones needing to be replaced due to various hazards found', autoDot: false, createdAt: '2026-04-06T02:27:12Z', updatedAt: '2026-04-06T02:27:12Z' },
  { id: 'mt-mnmlt951rfu1', equipmentId: 'eq-mnevvq8q6tcx', title: 'fifth wheel', dueDate: '2026-06-30', priority: 'low', status: 'upcoming', notes: 'fifth wheel possibly needs a rebuild theres a bent bolt making it hard to pull the release handle out sometimes maybe needs new bolt if possible', autoDot: false, createdAt: '2026-04-06T03:01:37Z', updatedAt: '2026-04-06T03:01:37Z' },
  { id: 'mt-mnmlli52qhxv', equipmentId: 'eq-mnevuhxgs5jf', title: 'phase 4', dueDate: '2026-06-30', priority: 'low', status: 'upcoming', notes: '6 shock absorbers and cross torque bars 3 air tanks underneath the stairs', autoDot: false, assignee: 'Jason', createdAt: '2026-04-06T02:55:35Z', updatedAt: '2026-04-06T02:55:35Z' },
  { id: 'mt-mnmksmmigohx', equipmentId: 'eq-mnewsbtqzn4b', title: 'lube chassis', dueDate: '2026-06-30', priority: 'low', status: 'complete', notes: 'lube landing gear and chassis', autoDot: false, createdAt: '2026-04-06T02:33:08Z', updatedAt: '2026-04-06T02:33:08Z' },
  { id: 'mt-mnmkoql7tskb', equipmentId: 'eq-mnewsbtqzn4b', title: 'crank handle', dueDate: '2026-06-30', priority: 'low', status: 'complete', notes: 'crank handle need to be replaced its bent and rusted', autoDot: false, createdAt: '2026-04-06T02:30:06Z', updatedAt: '2026-04-06T02:30:06Z' },
  { id: 'mt-mns69daay5dr', equipmentId: 'eq-mnewzfg20sho', title: 'door', dueDate: '2026-07-31', priority: 'low', status: 'upcoming', notes: "passenger side door doesn't close properly one of the mounting brackets attached to the trailer looked bent", autoDot: false, assignee: 'Jason', createdAt: '2026-04-10T00:32:52Z', updatedAt: '2026-04-10T00:32:52Z' },
]

const SEED_INVOICES: MaintenanceInvoice[] = [
  { id: 'inv-mpb5i4lalftq', equipmentId: 'eq-mnewsbtqzn4b', date: '2026-05-17', vendor: 'Jamie', description: '389\n4 air bags customer supplied\n4 brake chambers customer supplied\n1 air tank\n1 Spring brake valve\n1 crank handle\n\nParts 320\nLabor 1500\nTotal 1820', amount: 182000, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-05-18', createdAt: '2026-05-18T11:59:01Z', updatedAt: '2026-05-18T11:59:01Z' },
  { id: 'inv-mpb5gsos8s4w', equipmentId: 'eq-mnewsbtqzn4b', date: '2026-05-15', vendor: 'Kriete', description: 'Parts ordered\n4 chambers\n4 air bags\n4 yokes\nCredit for 44.76 tube fittings', amount: 118276, invoiceNumber: 'X103105858', paymentMethod: '', paymentDate: '2026-05-30', createdAt: '2026-05-18T11:57:58Z', updatedAt: '2026-05-18T11:57:58Z' },
  { id: 'inv-mp1g2o7tqgp8', equipmentId: 'eq-mnevuhxgs5jf', date: '2026-05-10', vendor: 'Jamie', description: '5th wheel greased', amount: 1000, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-05-11', createdAt: '2026-05-11T16:57:14Z', updatedAt: '2026-05-11T16:57:14Z' },
  { id: 'inv-mp1fzlfeqgj6', equipmentId: 'eq-mnewi3v8937x', date: '2026-05-10', vendor: 'Jamie', description: 'Dock lock and dock lock air bag replaced\nSlider valve replaced\nLegs greased', amount: 30000, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-05-11', createdAt: '2026-05-11T16:54:50Z', updatedAt: '2026-05-11T16:54:50Z' },
  { id: 'inv-mp1g8g8rs97d', equipmentId: 'eq-mnex02osubxo', date: '2026-05-10', vendor: 'Jamies', description: 'Legs greased up', amount: 2000, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-05-11', createdAt: '2026-05-11T17:01:43Z', updatedAt: '2026-05-11T17:01:43Z' },
  { id: 'inv-mp1g5030id1q', equipmentId: 'eq-mnevwst30vwt', date: '2026-05-10', vendor: 'Jamie', description: '5th wheel greased', amount: 1000, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-05-11', createdAt: '2026-05-11T16:59:02Z', updatedAt: '2026-05-11T16:59:02Z' },
  { id: 'inv-mp1g7b6xcd4t', equipmentId: 'eq-mnewvn8cag19', date: '2026-05-10', vendor: 'Jamie', description: 'Legs greased up', amount: 2500, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-05-11', createdAt: '2026-05-11T17:00:50Z', updatedAt: '2026-05-11T17:00:50Z' },
  { id: 'inv-mp1g6db6do9g', equipmentId: 'eq-mnew9mqmquur', date: '2026-05-10', vendor: 'Jamie', description: 'Legs greased up', amount: 2500, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-05-11', createdAt: '2026-05-11T17:00:06Z', updatedAt: '2026-05-11T17:00:06Z' },
  { id: 'inv-mp1g4abkts21', equipmentId: 'eq-mnevvq8q6tcx', date: '2026-05-10', vendor: 'Jamie', description: '5th wheel greased', amount: 1000, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-05-11', createdAt: '2026-05-11T16:58:29Z', updatedAt: '2026-05-11T16:58:29Z' },
  { id: 'inv-mp1gbo7s90oj', equipmentId: 'eq-mnewi3v8937x', date: '2026-05-07', vendor: 'Fleetpride', description: 'Dock lock assembly kit', amount: 35099, invoiceNumber: '134381998', paymentMethod: 'Credit Card', paymentDate: '2026-05-07', createdAt: '2026-05-11T17:04:14Z', updatedAt: '2026-05-11T17:04:14Z' },
  { id: 'inv-mou8asocbbah', equipmentId: 'eq-mnex02osubxo', date: '2026-05-06', vendor: 'Brothers', description: 'D.O.T service', amount: 5775, invoiceNumber: '13336', paymentMethod: 'ACH / Bank Transfer', paymentDate: '2026-05-05', createdAt: '2026-05-06T15:45:12Z', updatedAt: '2026-05-06T15:45:12Z' },
  { id: 'inv-mou8k4htgxov', equipmentId: 'eq-mnevvq8q6tcx', date: '2026-05-06', vendor: 'Brothers', description: 'Diagnosis done', amount: 11550, invoiceNumber: '13515', paymentMethod: 'ACH / Bank Transfer', paymentDate: '2026-05-05', createdAt: '2026-05-06T15:52:27Z', updatedAt: '2026-05-06T15:52:27Z' },
  { id: 'inv-mou8j3ys4v7x', equipmentId: 'eq-mnevvq8q6tcx', date: '2026-05-06', vendor: 'Brothers', description: 'PM service', amount: 51797, invoiceNumber: '13385', paymentMethod: 'ACH / Bank Transfer', paymentDate: '2026-05-05', createdAt: '2026-05-06T15:51:40Z', updatedAt: '2026-05-06T15:51:40Z' },
  { id: 'inv-mou8hxjg2zw9', equipmentId: 'eq-mnevwst30vwt', date: '2026-05-06', vendor: 'Brothers', description: 'Diagnosis done', amount: 11550, invoiceNumber: '13514', paymentMethod: 'ACH / Bank Transfer', paymentDate: '2026-05-05', createdAt: '2026-05-06T15:50:45Z', updatedAt: '2026-05-06T15:50:45Z' },
  { id: 'inv-mou8gnrd8sq9', equipmentId: 'eq-mnevwst30vwt', date: '2026-05-06', vendor: 'Brothers', description: 'PM service', amount: 51468, invoiceNumber: '13303', paymentMethod: 'ACH / Bank Transfer', paymentDate: '2026-05-05', createdAt: '2026-05-06T15:49:45Z', updatedAt: '2026-05-06T15:49:45Z' },
  { id: 'inv-mou8em7d99wf', equipmentId: 'eq-mnewwmcsjary', date: '2026-05-06', vendor: 'Brothers', description: 'Floor gaps sealed', amount: 11550, invoiceNumber: '13413', paymentMethod: 'ACH / Bank Transfer', paymentDate: '2026-05-05', createdAt: '2026-05-06T15:48:10Z', updatedAt: '2026-05-06T15:48:10Z' },
  { id: 'inv-mou8dcx2dum3', equipmentId: 'eq-mnewwmcsjary', date: '2026-05-06', vendor: 'Brothers', description: 'D.O.T service and brake chamber replaced', amount: 8663, invoiceNumber: '13306', paymentMethod: 'ACH / Bank Transfer', paymentDate: '2026-05-05', createdAt: '2026-05-06T15:47:11Z', updatedAt: '2026-05-06T15:47:11Z' },
  { id: 'inv-mou8bu84tvnq', equipmentId: 'eq-mnew9mqmquur', date: '2026-05-06', vendor: 'Brothers', description: '2 used tires installed', amount: 40320, invoiceNumber: '13356', paymentMethod: 'ACH / Bank Transfer', paymentDate: '2026-05-05', createdAt: '2026-05-06T15:46:01Z', updatedAt: '2026-05-06T15:46:01Z' },
  { id: 'inv-mo5hag9u8uw2', equipmentId: 'eq-mnewvn8cag19', date: '2026-04-18', vendor: 'Jamie', description: 'Replaced left side mudflap and rebent mudflap bracket', amount: 7000, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-04-24', createdAt: '2026-04-19T08:02:38Z', updatedAt: '2026-04-19T08:02:38Z' },
  { id: 'inv-mo5h91wcx6iu', equipmentId: 'eq-mnewh0pwm7vt', date: '2026-04-18', vendor: 'Jamie', description: 'Replaced clevis pins on front pins for tandems to be able to slide', amount: 7000, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-04-24', createdAt: '2026-04-19T08:01:33Z', updatedAt: '2026-04-19T08:01:33Z' },
  { id: 'inv-mo3cqcfqk9ax', equipmentId: 'eq-mnevvq8q6tcx', date: '2026-04-17', vendor: 'TRUCK DOCTOR', description: 'DEF, RADIATOR, GASKETS', amount: 493686, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-04-17', createdAt: '2026-04-17T20:19:29Z', updatedAt: '2026-04-17T20:19:29Z' },
  { id: 'inv-mo0euthnmm8b', equipmentId: 'eq-mnevxuyoxpd8', date: '2026-04-15', vendor: 'MISC', description: 'TIRES', amount: 114000, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-04-15', createdAt: '2026-04-15T18:55:38Z', updatedAt: '2026-04-15T18:55:38Z' },
  { id: 'inv-mnxpyx4dli3l', equipmentId: 'eq-mnewvn8cag19', date: '2026-04-13', vendor: 'MISC', description: 'hole in floor', amount: 16846, invoiceNumber: '', paymentMethod: 'Credit Card', paymentDate: '2026-04-13', createdAt: '2026-04-13T21:43:27Z', updatedAt: '2026-04-13T21:43:27Z' },
  { id: 'inv-mnv2jtzdcedz', equipmentId: 'eq-mnevuhxgs5jf', date: '2026-04-12', vendor: 'Jamie', description: 'Right rear axle brake chamber\n3 slack adjusters on right side replaced\nI supplied 2 drive axle slacks\nGreased all slack adjusters\nParts and labor Total 775', amount: 77500, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-04-15', createdAt: '2026-04-12T01:12:20Z', updatedAt: '2026-04-12T01:12:20Z' },
  { id: 'inv-mnte2sblbdei', equipmentId: 'eq-mnevvq8q6tcx', date: '2026-04-10', vendor: 'Kriete', description: '2 wiper blades', amount: 1130, invoiceNumber: 'x103103880:01', paymentMethod: '', paymentDate: '', createdAt: '2026-04-10T20:59:28Z', updatedAt: '2026-04-10T20:59:28Z' },
  { id: 'inv-mnte0th96va9', equipmentId: 'eq-mnevuhxgs5jf', date: '2026-04-10', vendor: 'Kriete', description: 'Air filter and 2 wiper blades', amount: 11062, invoiceNumber: 'x103103880:01', paymentMethod: '', paymentDate: '', createdAt: '2026-04-10T20:57:57Z', updatedAt: '2026-04-10T20:57:57Z' },
  { id: 'inv-mnnllvl9fw17', equipmentId: 'eq-mnevxuyoxpd8', date: '2026-04-06', vendor: 'MISC', description: 'GLADHAND HOSE 12FT', amount: 23864, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2024-04-06', createdAt: '2026-04-06T19:43:38Z', updatedAt: '2026-04-06T19:43:38Z' },
  { id: 'inv-mnm2s951avoi', equipmentId: 'eq-mnevuhxgs5jf', date: '2026-04-03', vendor: 'Pomps', description: '3 rear axle tires and valves replaced with recap', amount: 124495, invoiceNumber: '160175103', paymentMethod: '', paymentDate: '', createdAt: '2026-04-05T18:08:58Z', updatedAt: '2026-04-05T18:08:58Z' },
  { id: 'inv-mnj9bg3mcuxg', equipmentId: 'eq-mnevuhxgs5jf', date: '2026-04-02', vendor: 'Kriete', description: 'Slack adjuster parts and returned clevis', amount: 16558, invoiceNumber: 'x103102690:01', paymentMethod: 'ACH / Bank Transfer', paymentDate: '2026-04-06', createdAt: '2026-04-03T18:48:32Z', updatedAt: '2026-04-03T18:48:32Z' },
  { id: 'inv-mnf1a61exo6t', equipmentId: 'eq-mnevxuyoxpd8', date: '2026-03-31', vendor: 'MISC', description: 'TIRES + BELTS', amount: 141500, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-03-31', createdAt: '2026-03-31T19:52:30Z', updatedAt: '2026-03-31T19:52:30Z' },
  { id: 'inv-mnf1cb6zwygp', equipmentId: 'eq-mnevvq8q6tcx', date: '2026-03-31', vendor: 'MISC', description: 'ROADSIDE COOLANT REFILL AND HOSE REPAIR', amount: 77500, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-03-31', createdAt: '2026-03-31T19:54:10Z', updatedAt: '2026-03-31T19:54:10Z' },
  { id: 'inv-mnf1mvqstq84', equipmentId: 'eq-mnewi3v8937x', date: '2026-03-30', vendor: 'POMPS', description: 'TIRES', amount: 91694, invoiceNumber: '160174924', paymentMethod: '', paymentDate: '', createdAt: '2026-03-31T20:02:23Z', updatedAt: '2026-03-31T20:02:23Z' },
  { id: 'inv-mnf1f429w7ls', equipmentId: 'eq-mnevuhxgs5jf', date: '2026-03-25', vendor: 'MISC', description: 'ROADSIDE BRAKE CHAMBER FIX', amount: 35000, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-03-25', createdAt: '2026-03-31T19:56:21Z', updatedAt: '2026-03-31T19:56:21Z' },
  { id: 'inv-mnf1h6afbo9p', equipmentId: 'eq-mnewh0pwm7vt', date: '2026-03-22', vendor: 'JAMIE', description: 'MIDTURN AND PIGTAIL REPLACED', amount: 65000, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-03-22', createdAt: '2026-03-31T19:57:57Z', updatedAt: '2026-03-31T19:57:57Z' },
  { id: 'inv-mnf1luoy2zj2', equipmentId: 'eq-mnewi3v8937x', date: '2026-03-20', vendor: 'POMPS', description: 'TIRES', amount: 121902, invoiceNumber: '', paymentMethod: '', paymentDate: '', createdAt: '2026-03-31T20:01:35Z', updatedAt: '2026-03-31T20:01:35Z' },
  { id: 'inv-mnnpr09w3334', equipmentId: 'eq-mnevuhxgs5jf', date: '2026-03-19', vendor: 'KRIETE', description: 'SLACK ADJUSTERS EC', amount: 79142, invoiceNumber: 'X103102567:01', paymentMethod: 'ACH / Bank Transfer', paymentDate: '2026-04-06', createdAt: '2026-04-06T21:39:36Z', updatedAt: '2026-04-06T21:39:36Z' },
  { id: 'inv-mnf19i225gbt', equipmentId: 'eq-mnevxuyoxpd8', date: '2026-03-19', vendor: 'VELOCITY', description: '', amount: 5387, invoiceNumber: 'XB310114609:01', paymentMethod: 'Credit Card', paymentDate: '2026-03-19', createdAt: '2026-03-31T19:51:59Z', updatedAt: '2026-03-31T19:51:59Z' },
  { id: 'inv-mnf177yl7ijn', equipmentId: 'eq-mnevxuyoxpd8', date: '2026-03-19', vendor: 'VELOCITY', description: '', amount: 70774, invoiceNumber: 'XB310114379', paymentMethod: 'Credit Card', paymentDate: '2026-03-19', createdAt: '2026-03-31T19:50:13Z', updatedAt: '2026-03-31T19:50:13Z' },
  { id: 'inv-mnf15pwinjp7', equipmentId: 'eq-mnevxuyoxpd8', date: '2026-03-19', vendor: 'MISC', description: 'BRAKES AND SHOES', amount: 85492, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-03-19', createdAt: '2026-03-31T19:49:03Z', updatedAt: '2026-03-31T19:49:03Z' },
  { id: 'inv-mnf12i8w86cs', equipmentId: 'eq-mnevxuyoxpd8', date: '2026-03-19', vendor: 'MISC', description: 'TIRES', amount: 60000, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-03-19', createdAt: '2026-03-31T19:46:33Z', updatedAt: '2026-03-31T19:46:33Z' },
  { id: 'inv-mnf124z8ufog', equipmentId: 'eq-mnevxuyoxpd8', date: '2026-03-18', vendor: 'MISC', description: 'HUB REPLACEMENT', amount: 40500, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-03-18', createdAt: '2026-03-31T19:46:16Z', updatedAt: '2026-03-31T19:46:16Z' },
  { id: 'inv-mnf10vlqhk3t', equipmentId: 'eq-mnevxuyoxpd8', date: '2026-03-17', vendor: 'MISC', description: 'FUEL LINES', amount: 89042, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-03-17', createdAt: '2026-03-31T19:45:17Z', updatedAt: '2026-03-31T19:45:17Z' },
  { id: 'inv-mnf0uigmtanb', equipmentId: 'eq-mnevxuyoxpd8', date: '2026-03-13', vendor: 'MISC', description: 'SERVICE AND TOW', amount: 65700, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-03-13', createdAt: '2026-03-31T19:40:20Z', updatedAt: '2026-03-31T19:40:20Z' },
  { id: 'inv-mnf1w1w2xkxp', equipmentId: 'eq-mnevuhxgs5jf', date: '2026-03-10', vendor: 'BROTHERHOOD IN BUSINESS', description: 'TOWING TRK\nREPLACED COOLANT RADIATOR VOLVO\nREPLACED HOOD RELEASE LATCH FROM STEERING WHEEL (CUSTOMER PART)', amount: 205982, invoiceNumber: '13273', paymentMethod: 'Zelle', paymentDate: '2026-03-10', createdAt: '2026-03-31T20:09:31Z', updatedAt: '2026-03-31T20:09:31Z' },
  { id: 'inv-mnf0tnfi6rgj', equipmentId: 'eq-mnevxuyoxpd8', date: '2026-03-10', vendor: 'MISC', description: 'HEADLIGHT BULBS', amount: 20700, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-03-31', createdAt: '2026-03-31T19:39:40Z', updatedAt: '2026-03-31T19:39:40Z' },
  { id: 'inv-mnf1sxfgfsp4', equipmentId: 'eq-mnewjegoteii', date: '2026-03-09', vendor: 'BROTHERHOOD IN BUSINESS', description: 'REPLACE LEFT TRAILER LEG', amount: 139336, invoiceNumber: '13266', paymentMethod: 'Zelle', paymentDate: '2026-03-09', createdAt: '2026-03-31T20:07:06Z', updatedAt: '2026-03-31T20:07:06Z' },
  { id: 'inv-mnf0svwmgnue', equipmentId: 'eq-mnevxuyoxpd8', date: '2026-03-02', vendor: 'LOVES', description: 'FORCED REGEN', amount: 129635, invoiceNumber: '', paymentMethod: 'Credit Card', paymentDate: '2026-03-31', createdAt: '2026-03-31T19:39:04Z', updatedAt: '2026-03-31T19:39:04Z' },
  { id: 'inv-mnf1q4xiv08f', equipmentId: 'eq-mnevwst30vwt', date: '2026-02-19', vendor: 'BROTHERHOOD IN BUSINESS', description: 'FIX STEERING WHEEL POSITION LOCK\nREPLACE BELT TENSIONER AND BOTH BELTS\nDIAG ELECTRICAL ISSUE WITH POWER MIRRORS AND DASH LIGHTING', amount: 114458, invoiceNumber: '12907', paymentMethod: 'Zelle', paymentDate: '2026-02-19', createdAt: '2026-03-31T20:04:55Z', updatedAt: '2026-03-31T20:04:55Z' },
  { id: 'inv-mnf1ilq1dr8e', equipmentId: 'eq-mnevvq8q6tcx', date: '2026-02-19', vendor: 'JAMIE', description: 'BELT REPLACEMENT', amount: 10000, invoiceNumber: '', paymentMethod: 'Zelle', paymentDate: '2026-02-19', createdAt: '2026-03-31T19:59:04Z', updatedAt: '2026-03-31T19:59:04Z' },
  { id: 'inv-mnf0prhpw5pg', equipmentId: 'eq-mnevxuyoxpd8', date: '2026-02-09', vendor: 'BROTHERHOOD IN BUSINESS', description: '- OIL/PM\n- RADIO\n- INVERTER\n- HEADLIGHT\n- TIRES', amount: 199390, invoiceNumber: '13102', paymentMethod: 'Zelle', paymentDate: '2026-02-09', createdAt: '2026-03-31T19:36:38Z', updatedAt: '2026-03-31T19:36:38Z' },
  { id: 'inv-mnf0np3muiwi', equipmentId: 'eq-mnevxuyoxpd8', date: '2026-02-09', vendor: 'MISC', description: 'MATTS', amount: 7911, invoiceNumber: '', paymentMethod: 'Credit Card', paymentDate: '2026-02-09', createdAt: '2026-03-31T19:35:02Z', updatedAt: '2026-03-31T19:35:02Z' },
  { id: 'inv-mnf1rn6ecalz', equipmentId: 'eq-mnewh0pwm7vt', date: '2026-02-03', vendor: 'BROTHERHOOD IN BUSINESS', description: 'REPLACE REAR LOCKING BAR', amount: 28875, invoiceNumber: '13070', paymentMethod: 'Zelle', paymentDate: '2026-02-03', createdAt: '2026-03-31T20:06:06Z', updatedAt: '2026-03-31T20:06:06Z' },
  { id: 'inv-mnf1uuwbjsog', equipmentId: 'eq-mnevuhxgs5jf', date: '2026-01-20', vendor: 'BROTHERHOOD IN BUSINESS', description: 'PM SERVICE\nMILES - 344957', amount: 50844, invoiceNumber: '13001', paymentMethod: 'Zelle', paymentDate: '2026-01-20', createdAt: '2026-03-31T20:08:36Z', updatedAt: '2026-03-31T20:08:36Z' },
]

// ── Expense seed data ──────────────────────────────────────────────────────────
function daysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}
function expId(n: number) { return `exp-${n}` }
function ts(n: number) { return `${daysAgo(n)}T12:00:00Z` }

const SEED_EXPENSES: Expense[] = [
  { id: expId(1),  truckId: 'eq-mnevuhxgs5jf', category: 'fuel',        amount: 45000, date: daysAgo(1),  vendor: "Love's Travel Stop",   description: 'Fuel fill-up',      createdAt: ts(1),  updatedAt: ts(1),  createdBy: 'dispatch' },
  { id: expId(2),  truckId: 'eq-mnevvq8q6tcx', category: 'fuel',        amount: 52000, date: daysAgo(2),  vendor: 'Pilot Flying J',        description: 'Fuel fill-up',      createdAt: ts(2),  updatedAt: ts(2),  createdBy: 'dispatch' },
  { id: expId(3),  truckId: 'eq-mnevwst30vwt', category: 'maintenance', amount: 78000, date: daysAgo(3),  vendor: 'Rush Truck Centers',    description: 'Oil change + DEF',  createdAt: ts(3),  updatedAt: ts(3),  createdBy: 'dispatch' },
  { id: expId(4),  truckId: 'eq-mnevxuyoxpd8', category: 'fuel',        amount: 41000, date: daysAgo(4),  vendor: 'TA Petro',              description: 'Fuel fill-up',      createdAt: ts(4),  updatedAt: ts(4),  createdBy: 'dispatch' },
  { id: expId(5),  truckId: 'eq-mnevuhxgs5jf', category: 'tolls',       amount: 3200,  date: daysAgo(5),  vendor: 'I-Pass',                description: 'Illinois tollway',  createdAt: ts(5),  updatedAt: ts(5),  createdBy: 'dispatch' },
  { id: expId(6),  truckId: 'eq-mnevvq8q6tcx', category: 'maintenance', amount: 62000, date: daysAgo(7),  vendor: 'Speedco',               description: 'Tire rotation',     createdAt: ts(7),  updatedAt: ts(7),  createdBy: 'dispatch' },
  { id: expId(7),  truckId: 'eq-mnevwst30vwt', category: 'fuel',        amount: 49000, date: daysAgo(9),  vendor: "Love's Travel Stop",   description: 'Fuel fill-up',      createdAt: ts(9),  updatedAt: ts(9),  createdBy: 'dispatch' },
  { id: expId(8),  truckId: 'eq-mnevxuyoxpd8', category: 'maintenance', amount: 28000, date: daysAgo(10), vendor: 'local shop',            description: 'Brake inspection',  createdAt: ts(10), updatedAt: ts(10), createdBy: 'dispatch' },
  { id: expId(9),  truckId: 'eq-mnevuhxgs5jf', category: 'fuel',        amount: 53000, date: daysAgo(12), vendor: 'Pilot Flying J',        description: 'Fuel fill-up',      createdAt: ts(12), updatedAt: ts(12), createdBy: 'dispatch' },
  { id: expId(10), truckId: 'eq-mnevvq8q6tcx', category: 'fuel',        amount: 47000, date: daysAgo(14), vendor: 'TA Petro',              description: 'Fuel fill-up',      createdAt: ts(14), updatedAt: ts(14), createdBy: 'dispatch' },
  { id: expId(11), truckId: 'eq-mnevwst30vwt', category: 'insurance',   amount: 120000,date: daysAgo(15), vendor: 'Progressive Commercial', description: 'Monthly premium',  createdAt: ts(15), updatedAt: ts(15), createdBy: 'dispatch' },
  { id: expId(12), truckId: 'eq-mnevxuyoxpd8', category: 'fuel',        amount: 38000, date: daysAgo(18), vendor: "Love's Travel Stop",   description: 'Fuel fill-up',      createdAt: ts(18), updatedAt: ts(18), createdBy: 'dispatch' },
  { id: expId(13), truckId: 'eq-mnevuhxgs5jf', category: 'maintenance', amount: 95000, date: daysAgo(21), vendor: 'Rush Truck Centers',    description: 'ELD issue repair',  createdAt: ts(21), updatedAt: ts(21), createdBy: 'dispatch' },
  { id: expId(14), truckId: 'eq-mnevvq8q6tcx', category: 'tolls',       amount: 2800,  date: daysAgo(23), vendor: 'E-ZPass',               description: 'OH Turnpike',       createdAt: ts(23), updatedAt: ts(23), createdBy: 'dispatch' },
  { id: expId(15), truckId: 'eq-mnevwst30vwt', category: 'fuel',        amount: 51000, date: daysAgo(28), vendor: 'Pilot Flying J',        description: 'Fuel fill-up',      createdAt: ts(28), updatedAt: ts(28), createdBy: 'dispatch' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowIso(): string { return new Date().toISOString() }
function initWeekStart(): string {
  return getMondayOf(new Date()).toISOString().slice(0, 10)
}

function diffChanges<T extends object>(
  before: Partial<T>,
  after: Partial<T>
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  keys.forEach((k) => {
    const prev = (before as Record<string, unknown>)[k]
    const next = (after as Record<string, unknown>)[k]
    if (prev !== next) changes[k] = { from: prev, to: next }
  })
  return changes
}

// ── State interface ───────────────────────────────────────────────────────────

interface AppState {
  // ── Data (loaded from API) ─────────────────────────────────────────────────
  drivers: Driver[]
  loads: Load[]
  auditLog: AuditLogEntry[]
  isLoading: boolean
  error: string | null
  currentUserEmail: string

  // ── Local data (no backend yet — Zustand only) ─────────────────────────────
  equipment: Equipment[]
  maintenanceTasks: MaintenanceTask[]
  maintenanceInvoices: MaintenanceInvoice[]
  expenses: Expense[]

  // ── UI (persisted to localStorage) ────────────────────────────────────────
  viewMode: ViewMode
  weekStart: string
  selectedLoadId: string | null
  drawerMode: 'view' | 'edit' | 'create' | null
  createPreFill: { driverId: string | null; dateStr: string } | null
  filterDriverId: string | null
  searchQuery: string
  filters: { readyToInvoice: boolean; split: boolean; unassigned: boolean }

  // ── Initialization ─────────────────────────────────────────────────────────
  initializeData: (userEmail: string) => Promise<void>
  setCurrentUser: (email: string) => void

  // ── Driver actions ─────────────────────────────────────────────────────────
  addDriver: (d: Omit<Driver, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Driver>
  updateDriver: (id: string, patch: Partial<Omit<Driver, 'id' | 'createdAt'>>) => Promise<void>
  deleteDriver: (id: string) => Promise<void>

  // ── Load actions ───────────────────────────────────────────────────────────
  addLoad: (l: Omit<Load, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  updateLoad: (id: string, patch: Partial<Omit<Load, 'id' | 'createdAt'>>) => Promise<void>
  deleteLoad: (id: string) => Promise<void>

  // ── Equipment actions (local) ──────────────────────────────────────────────
  addEquipment: (e: Omit<Equipment, 'id' | 'createdAt' | 'updatedAt'>) => Equipment
  updateEquipment: (id: string, patch: Partial<Omit<Equipment, 'id' | 'createdAt'>>) => void
  deleteEquipment: (id: string) => void

  // ── Maintenance actions (local) ────────────────────────────────────────────
  addMaintenanceTask: (t: Omit<MaintenanceTask, 'id' | 'createdAt' | 'updatedAt'>) => void
  updateMaintenanceTask: (id: string, patch: Partial<Omit<MaintenanceTask, 'id' | 'createdAt'>>) => void
  deleteMaintenanceTask: (id: string) => void
  addMaintenanceInvoice: (i: Omit<MaintenanceInvoice, 'id' | 'createdAt' | 'updatedAt'>) => void
  updateMaintenanceInvoice: (id: string, patch: Partial<Omit<MaintenanceInvoice, 'id' | 'createdAt'>>) => void
  deleteMaintenanceInvoice: (id: string) => void

  // ── Expense actions (local) ────────────────────────────────────────────────
  addExpense: (e: Omit<Expense, 'id' | 'createdAt' | 'updatedAt'>) => void
  updateExpense: (id: string, patch: Partial<Omit<Expense, 'id' | 'createdAt'>>) => void
  deleteExpense: (id: string) => void

  // ── UI actions ─────────────────────────────────────────────────────────────
  setViewMode: (m: ViewMode) => void
  setWeekStart: (d: string) => void
  setSelectedLoad: (
    id: string | null,
    mode?: 'view' | 'edit' | 'create',
    preFill?: { driverId: string | null; dateStr: string }
  ) => void
  setFilterDriver: (id: string | null) => void
  setSearchQuery: (q: string) => void
  toggleFilter: (f: keyof AppState['filters']) => void
}

// ── Audit helper ──────────────────────────────────────────────────────────────

function writeAudit(
  user: string,
  entityType: EntityType,
  entityId: string,
  action: AuditAction,
  changes: AuditLogEntry['changes']
) {
  // Fire-and-forget — audit log failures shouldn't block the user
  api.createAuditLog({ entityType, entityId, action, user, changes }).catch(() => {})
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // ── Initial state ──────────────────────────────────────────────────────
      drivers: [],
      loads: [],
      auditLog: [],
      isLoading: false,
      error: null,
      currentUserEmail: 'dispatch@bcat.local',

      equipment: SEED_EQUIPMENT,
      maintenanceTasks: SEED_TASKS,
      maintenanceInvoices: SEED_INVOICES,
      expenses: SEED_EXPENSES,

      viewMode: 'compact' as ViewMode,
      weekStart: initWeekStart(),
      selectedLoadId: null,
      drawerMode: null,
      createPreFill: null,
      filterDriverId: null,
      searchQuery: '',
      filters: { readyToInvoice: false, split: false, unassigned: false },

      // ── Init ───────────────────────────────────────────────────────────────
      setCurrentUser: (email) => set({ currentUserEmail: email }),

      initializeData: async (userEmail) => {
        set({ isLoading: true, error: null, currentUserEmail: userEmail })
        try {
          const [loads, drivers, auditLog] = await Promise.all([
            api.listLoads(),
            api.listDrivers(),
            api.listAuditLogs(),
          ])
          set({ loads, drivers, auditLog, isLoading: false })
        } catch (err) {
          console.error('[store] initializeData failed', err)
          set({ isLoading: false, error: errorMessage(err) })
        }
      },

      // ── Drivers ────────────────────────────────────────────────────────────
      addDriver: async (d) => {
        const driver = await api.createDriver(d)
        set((s) => ({ drivers: [...s.drivers, driver] }))
        writeAudit(get().currentUserEmail, 'Driver', driver.id, 'create', {
          _snapshot: { from: null, to: driver },
        })
        return driver
      },

      updateDriver: async (id, patch) => {
        const before = get().drivers.find((d) => d.id === id)
        if (!before) return
        // Do NOT pass updatedAt — Amplify Gen 2 manages it server-side.
        // Passing it in UpdateDriverInput causes a GraphQL validation error.
        const after = await api.updateDriver(id, patch)
        set((s) => ({ drivers: s.drivers.map((d) => (d.id === id ? after : d)) }))
        writeAudit(get().currentUserEmail, 'Driver', id, 'update', diffChanges(before, after))
      },

      deleteDriver: async (id) => {
        const before = get().drivers.find((d) => d.id === id)
        if (!before) return
        await api.deleteDriver(id)
        set((s) => ({ drivers: s.drivers.filter((d) => d.id !== id) }))
        writeAudit(get().currentUserEmail, 'Driver', id, 'delete', {
          _snapshot: { from: before, to: null },
        })
      },

      // ── Loads ──────────────────────────────────────────────────────────────
      addLoad: async (l) => {
        const load = await api.createLoad(l)
        set((s) => ({ loads: [...s.loads, load] }))
        writeAudit(get().currentUserEmail, 'Load', load.id, 'create', {
          _snapshot: { from: null, to: load },
        })
      },

      updateLoad: async (id, patch) => {
        const before = get().loads.find((l) => l.id === id)
        if (!before) return
        // Do NOT pass updatedAt — Amplify Gen 2 manages it server-side.
        const after = await api.updateLoad(id, {
          ...patch,
          updatedBy: get().currentUserEmail,
        })
        set((s) => ({ loads: s.loads.map((l) => (l.id === id ? after : l)) }))
        writeAudit(get().currentUserEmail, 'Load', id, 'update', diffChanges(before, after))
      },

      deleteLoad: async (id) => {
        const before = get().loads.find((l) => l.id === id)
        if (!before) return
        await api.deleteLoad(id)
        set((s) => ({ loads: s.loads.filter((l) => l.id !== id) }))
        writeAudit(get().currentUserEmail, 'Load', id, 'delete', {
          _snapshot: { from: before, to: null },
        })
      },

      // ── Equipment ──────────────────────────────────────────────────────────
      addEquipment: (e) => {
        const item: Equipment = { ...e, id: `equip-${Date.now()}`, createdAt: nowIso(), updatedAt: nowIso() }
        set((s) => ({ equipment: [...s.equipment, item] }))
        return item
      },
      updateEquipment: (id, patch) => {
        set((s) => ({ equipment: s.equipment.map((e) => e.id === id ? { ...e, ...patch, updatedAt: nowIso() } : e) }))
      },
      deleteEquipment: (id) => {
        set((s) => ({
          equipment: s.equipment.filter((e) => e.id !== id),
          maintenanceTasks: s.maintenanceTasks.filter((t) => t.equipmentId !== id),
          maintenanceInvoices: s.maintenanceInvoices.filter((i) => i.equipmentId !== id),
        }))
      },

      // ── Maintenance tasks ──────────────────────────────────────────────────
      addMaintenanceTask: (t) => {
        const task: MaintenanceTask = { ...t, id: `task-${Date.now()}`, createdAt: nowIso(), updatedAt: nowIso() }
        set((s) => ({ maintenanceTasks: [...s.maintenanceTasks, task] }))
      },
      updateMaintenanceTask: (id, patch) => {
        set((s) => ({ maintenanceTasks: s.maintenanceTasks.map((t) => t.id === id ? { ...t, ...patch, updatedAt: nowIso() } : t) }))
      },
      deleteMaintenanceTask: (id) => {
        set((s) => ({ maintenanceTasks: s.maintenanceTasks.filter((t) => t.id !== id) }))
      },

      // ── Maintenance invoices ───────────────────────────────────────────────
      addMaintenanceInvoice: (i) => {
        const inv: MaintenanceInvoice = { ...i, id: `inv-${Date.now()}`, createdAt: nowIso(), updatedAt: nowIso() }
        set((s) => ({ maintenanceInvoices: [...s.maintenanceInvoices, inv] }))
      },
      updateMaintenanceInvoice: (id, patch) => {
        set((s) => ({ maintenanceInvoices: s.maintenanceInvoices.map((i) => i.id === id ? { ...i, ...patch, updatedAt: nowIso() } : i) }))
      },
      deleteMaintenanceInvoice: (id) => {
        set((s) => ({ maintenanceInvoices: s.maintenanceInvoices.filter((i) => i.id !== id) }))
      },

      // ── Expenses ───────────────────────────────────────────────────────────
      addExpense: (e) => {
        const expense: Expense = { ...e, id: `exp-${Date.now()}`, createdAt: nowIso(), updatedAt: nowIso() }
        set((s) => ({ expenses: [...s.expenses, expense] }))
      },
      updateExpense: (id, patch) => {
        set((s) => ({ expenses: s.expenses.map((e) => e.id === id ? { ...e, ...patch, updatedAt: nowIso() } : e) }))
      },
      deleteExpense: (id) => {
        set((s) => ({ expenses: s.expenses.filter((e) => e.id !== id) }))
      },

      // ── UI ─────────────────────────────────────────────────────────────────
      setViewMode: (m) => set({ viewMode: m }),
      setWeekStart: (d) => set({ weekStart: d }),
      setSelectedLoad: (id, mode = 'view', preFill) =>
        set({
          selectedLoadId: id,
          drawerMode: id === null && mode !== 'create' ? null : mode,
          createPreFill: preFill ?? null,
        }),
      setFilterDriver: (id) => set({ filterDriverId: id }),
      setSearchQuery: (q) => set({ searchQuery: q }),
      toggleFilter: (f) =>
        set((s) => ({ filters: { ...s.filters, [f]: !s.filters[f] } })),
    }),
    {
      name: 'bcat-ops-ui-v4',
      // Persist UI prefs + local-only data (equipment/maintenance have no backend yet)
      partialize: (s) => ({
        viewMode: s.viewMode,
        weekStart: s.weekStart,
        filters: s.filters,
        equipment: s.equipment,
        maintenanceTasks: s.maintenanceTasks,
        maintenanceInvoices: s.maintenanceInvoices,
      }),
    }
  )
)
