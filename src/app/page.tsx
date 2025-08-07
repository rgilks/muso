import ClientAmbient from "./ui/ClientAmbient";

export default function Home() {
  return (
    <main className="min-h-screen p-6 md:p-10 bg-[#0B0B0F] text-[#DDE7FF]">
      <h1 className="text-3xl font-semibold mb-4">muso</h1>
      <ClientAmbient />
    </main>
  );
}
