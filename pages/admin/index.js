import AdminDashboard from "@/components/admin/dashboard";
import AdminLayout from "@/components/admin/layout";
import AppendMeta from "@/components/admin/meta/AppendMeta";
import MetadataEditor from "@/components/admin/meta/MetadataEditor";
import AdminReports from "@/components/admin/reports";
import UsersCard from "@/components/admin/dashboard/UsersCard";
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
        {page === 4 && (
          <p className="flex-center h-full text-white/40">
            Settings coming soon.
          </p>
        )}
        {page === 5 && <AdminReports />}
      </div>
    </AdminLayout>
  );
}
