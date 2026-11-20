import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter, Routes, Route } from "react-router-dom";
import Index from "./pages/Index";
const NotFound = lazy(() => import("./pages/NotFound"));
const CompanionWindow = lazy(() => import("./components/CompanionWindow"));

const queryClient = new QueryClient();
const Router = window.location.protocol === "file:" ? HashRouter : BrowserRouter;

const App = () => {
const isCompanion =
new URLSearchParams(window.location.search).get("exileWindow") === "companion";

if (isCompanion) {
return <Suspense fallback={null}><CompanionWindow /></Suspense>;
}

return ( <QueryClientProvider client={queryClient}> <TooltipProvider> <Toaster /> <Sonner /> <Router> <Routes>
<Route path="/" element={<Index />} />
<Route path="*" element={<Suspense fallback={null}><NotFound /></Suspense>} /> </Routes> </Router> </TooltipProvider> </QueryClientProvider>
);
};

export default App;
