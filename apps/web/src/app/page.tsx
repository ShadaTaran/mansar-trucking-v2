import { redirect } from 'next/navigation';

/** The admin web has no public landing page: go straight to the dashboard. */
export default function Home(): never {
  redirect('/dashboard');
}
