import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { Toaster } from '@/components/ui/sonner';
import { AppHeader } from '@/components/AppHeader';
import { Loading } from '@/components/States';
import { UrlSync } from '@/lib/useWorkspace';

const Workspace = lazy(() => import('@/views/Workspace'));

export function App() {
  return (
    <div className="flex h-full flex-col">
      <UrlSync />
      <AppHeader />
      <main className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<Loading label="Loading" />}>
          <Routes>
            <Route path="/" element={<Workspace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
      <Toaster position="bottom-right" />
    </div>
  );
}
