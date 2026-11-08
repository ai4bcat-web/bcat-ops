/** "Welcome back, <first name>!" with an initial avatar — the dashboard's eyebrow row. */
export function WelcomeHeader({ name }: { name: string }) {
  return (
    <span className="tms-welcome">
      <span className="tms-welcome-avatar" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
      <span>{`Welcome back, ${name}!`}</span>
    </span>
  )
}

export default WelcomeHeader
