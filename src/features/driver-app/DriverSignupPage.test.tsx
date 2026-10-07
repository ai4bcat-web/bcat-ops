// @vitest-environment jsdom
/**
 * The case this page kept getting wrong: a driver follows their invite link, picks a
 * password, and is told "User already exists" — a dead end for someone who was invited
 * and did nothing wrong. It should set the password on the account they already have.
 *
 * What must stay true is that knowing an email address is never enough to do that. So
 * the tests check both halves: the driver gets through, and a code goes to their address
 * first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import DriverSignupPage from './DriverSignupPage'

const signUp = vi.fn()
const confirmSignUp = vi.fn()
const resendConfirmationCode = vi.fn()
const signIn = vi.fn()
const forgotPassword = vi.fn()
const confirmForgotPassword = vi.fn()
const navigate = vi.fn()

vi.mock('./useDriverAuth', () => ({
  useDriverAuth: () => ({
    signUp, confirmSignUp, resendConfirmationCode, signIn,
    forgotPassword, confirmForgotPassword,
  }),
}))

vi.mock('./InstallHintSection', () => ({
  InstallHintSection: () => <section aria-label="Install this app">Add to Home Screen</section>,
}))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigate }
})

/** How the auth context rethrows an AWS failure. */
const awsError = (name: string, message = name) =>
  new Error(message, { cause: Object.assign(new Error(message), { name }) })

/**
 * Reject lazily: a mock configured with an eager rejected promise leaves an unhandled
 * rejection behind whenever that mock is never called.
 */
function rejectsWith(mock: { mockImplementation: (fn: () => Promise<never>) => unknown }, err: Error) {
  mock.mockImplementation(() => Promise.reject(err))
}

const EMAIL = 'ryne@bcatcorp.com'
const PASSWORD = 'Str0ngPassw0rd!'

function renderSignup() {
  return render(
    <MemoryRouter>
      <DriverSignupPage />
    </MemoryRouter>,
  )
}

/** Fill the first screen and submit it. */
async function submitForm() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: EMAIL } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: PASSWORD } })
  fireEvent.click(screen.getByRole('button', { name: /sign up/i }))
}

beforeEach(() => {
  vi.clearAllMocks()
  signUp.mockResolvedValue(undefined)
  confirmSignUp.mockResolvedValue(undefined)
  resendConfirmationCode.mockResolvedValue(undefined)
  signIn.mockResolvedValue(undefined)
  forgotPassword.mockResolvedValue(undefined)
  confirmForgotPassword.mockResolvedValue(undefined)
})

describe('a brand-new driver', () => {
  it('signs up and confirms with the emailed code', async () => {
    renderSignup()
    await submitForm()

    await waitFor(() => expect(signUp).toHaveBeenCalledWith(EMAIL, PASSWORD))
    expect(await screen.findByText(/finish setting up your sign-in/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify email' }))

    await waitFor(() => expect(confirmSignUp).toHaveBeenCalledWith(EMAIL, '123456'))
    expect(forgotPassword).not.toHaveBeenCalled()
    await waitFor(() => expect(signIn).toHaveBeenCalledWith(EMAIL, PASSWORD))
    // Finishing here rather than navigating: the route tree only grows the authenticated
    // routes once auth state has committed, and navigating first bounced to login.
    expect(await screen.findByRole('heading', { name: "You're signed in" })).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('a driver whose account already exists', () => {
  beforeEach(() => rejectsWith(signUp, awsError('UsernameExistsException', 'User already exists')))

  it('does not dead-end them, and sends a code to their address instead', async () => {
    renderSignup()
    await submitForm()

    // The old behaviour: an error banner saying "User already exists" and no way forward.
    await waitFor(() => expect(forgotPassword).toHaveBeenCalledWith(EMAIL))
    expect(screen.queryByText(/User already exists/)).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Confirm it is you' })).toBeInTheDocument()
    expect(screen.getByText(/already have an account/i)).toBeInTheDocument()
  })

  it('sets the password they chose once they enter the code, then signs them in', async () => {
    renderSignup()
    await submitForm()
    await screen.findByLabelText('Verification code')

    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set my password' }))

    await waitFor(() =>
      expect(confirmForgotPassword).toHaveBeenCalledWith(EMAIL, '654321', PASSWORD),
    )
    // Never confirmSignUp: that account is already confirmed.
    expect(confirmSignUp).not.toHaveBeenCalled()
    await waitFor(() => expect(signIn).toHaveBeenCalledWith(EMAIL, PASSWORD))
    expect(await screen.findByRole('heading', { name: "You're signed in" })).toBeInTheDocument()
  })

  it('resends a reset code, not a sign-up code', async () => {
    renderSignup()
    await submitForm()
    await screen.findByLabelText('Verification code')
    forgotPassword.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Resend code' }))

    await waitFor(() => expect(forgotPassword).toHaveBeenCalledWith(EMAIL))
    expect(resendConfirmationCode).not.toHaveBeenCalled()
  })

  it('falls back to a sign-up code when the account never confirmed its email', async () => {
    // Cognito refuses a reset for an unconfirmed user, so the sign-up code is what works.
    rejectsWith(forgotPassword, awsError('InvalidParameterException'))
    renderSignup()
    await submitForm()

    await waitFor(() => expect(resendConfirmationCode).toHaveBeenCalledWith(EMAIL))
    expect(await screen.findByRole('button', { name: 'Verify email' })).toBeInTheDocument()
  })

  it('reports a reset failure it cannot work around', async () => {
    rejectsWith(forgotPassword, awsError('LimitExceededException', 'Attempt limit exceeded'))
    renderSignup()
    await submitForm()

    expect(await screen.findByText('Attempt limit exceeded')).toBeInTheDocument()
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument()
  })
})

describe('failures that must still stop the driver', () => {
  it('shows the roster gate refusing someone', async () => {
    // The PreSignUp trigger is the only roster check; swallowing it would let anyone in.
    rejectsWith(signUp, new Error('No driver record matches this email. Contact dispatch.'))
    renderSignup()
    await submitForm()

    expect(await screen.findByText(/No driver record matches this email/)).toBeInTheDocument()
    expect(forgotPassword).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument()
  })

  it('shows a weak password being rejected', async () => {
    rejectsWith(signUp, awsError('InvalidPasswordException', 'Password did not conform with policy'))
    renderSignup()
    await submitForm()

    expect(await screen.findByText(/did not conform with policy/)).toBeInTheDocument()
    expect(forgotPassword).not.toHaveBeenCalled()
  })

  it('will not submit mismatched passwords at all', async () => {
    renderSignup()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: EMAIL } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'different' } })
    fireEvent.click(screen.getByRole('button', { name: /sign up/i }))

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument()
    expect(signUp).not.toHaveBeenCalled()
  })
})

describe('the last screen', () => {
  it('shows how to add the app to the home screen, and a way in', async () => {
    renderSignup()
    await submitForm()
    fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify email' }))

    await screen.findByRole('heading', { name: "You're signed in" })
    expect(screen.getByLabelText('Install this app')).toBeInTheDocument()

    // Navigation is the driver's choice, taken after auth state has settled — and it lands
    // on the settlement, which is the only page the app has.
    fireEvent.click(screen.getByRole('button', { name: 'Open the driver app' }))
    // The landing route picks the program's home; a fixed settlement hop 409s for Ivan.
    expect(navigate).toHaveBeenCalledWith('/driver')
  })

  it('says the password is set when only the sign-in fails', async () => {
    // Rolled together, this read as "the code did not work" and sent the driver back to
    // re-enter a code that was already spent.
    rejectsWith(signIn, new Error('Network error'))
    renderSignup()
    await submitForm()
    fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify email' }))

    const msg = await screen.findByText(/Your password is set, but signing in failed/)
    expect(msg).toHaveTextContent('Network error')
    expect(msg).toHaveTextContent('login screen')
  })

  it('still blames the code when the code is what was wrong', async () => {
    rejectsWith(confirmSignUp, awsError('CodeMismatchException', 'Invalid verification code provided'))
    renderSignup()
    await submitForm()
    fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '000000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify email' }))

    expect(await screen.findByText('Invalid verification code provided')).toBeInTheDocument()
    expect(signIn).not.toHaveBeenCalled()
  })
})
