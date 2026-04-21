import './globals.css';
import Link from 'next/link';

export const metadata = {
  title: 'Meta Competitor Ad Library',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>
        <main>
          <p>
            <Link href="/">Dashboard</Link>
          </p>
          {children}
        </main>
      </body>
    </html>
  );
}
