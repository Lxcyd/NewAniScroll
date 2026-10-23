import AdminDashboard from "@/components/admin/dashboard";
import AdminLayout from "@/components/admin/layout";
import dynamic from "next/dynamic";
/* Les onglets 2 a 6 : charges au clic. Le rendu serveur ne montre jamais que le
   tableau de bord (page 1), donc rien ne change a l'arrivee. */
const AppendMeta = dynamic(() => import("@/components/admin/meta/AppendMeta"));
const MetadataEditor = dynamic(() => import("@/components/admin/meta/MetadataEditor"));
const AdminReports = dynamic(() => import("@/components/admin/reports"));
const UsersCard = dynamic(() => import("@/components/admin/dashboard/UsersCard"));
const AuditCard = dynamic(() => import("@/components/admin/dashboard/AuditCard"));
const SystemCard = dynamic(() => import("@/components/admin/dashboard/SystemCard"));
import { isAdminSession } from "@/lib/auth/isAdmin";
import { getServerSession } from "next-auth";
import { authOptions } from "pages/api/auth/[...nextauth]";
import React, { useState } from "react";

export async function getServerSideProps(context) {
  const sessions = await getServerSession(
    context.req,
    context.res,
    authOptions
  );

  if (!sessions || !isAdminSession(sessions)) {
    return { redirect: { destination: "/", permanent: false } };
  }

  let api = process.env.API_URI || null;
  if (api && api.endsWith("/")) api = api.slice(0, -1);

  return { props: { session: sessions, api } };
}

export default function Admin({ api }) {
  const [page, setPage] = useState(1);

  return (
    <AdminLayout page={page} setPage={setPage}>
      <div className="h-full">
        {page === 1 && <AdminDashboard />}
        {page === 2 && (
          <div className="px-6 py-8 space-y-8">
            <AppendMeta api={api} />
            <MetadataEditor />
          </div>
        )}
        {page === 3 && <UsersCard />}
        {page === 4 && <SystemCard />}
        {page === 5 && <AdminReports />}
        {page === 6 && <AuditCard />}
      </div>
    </AdminLayout>
  );
}
