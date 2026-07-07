import axios, { AxiosRequestConfig } from "axios";
import { getSession } from "next-auth/react";
import { notify } from "@/lib/notifications/noticeStore";

function isAnilist(url: string | undefined): boolean {
  return url?.includes("anilist.co") ?? false;
}

interface RequestOption extends RequestInit {
  headers?: {
    "Content-Type"?: string;
    Authorization?: string;
  };
}

const pls = {
  // GET request handler
  async get(
    url: string,
    options?: AxiosRequestConfig,
    ctx?: any
  ): Promise<any> {
    try {
      const session: any | null = isAnilist(url) ? await getSession(ctx) : null;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      try {
        const response = await axios.get(url, { ...options, signal: controller.signal });
        return response.data;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error: any) {
      handleError(error);
      return null;
    }
  },

  // POST request handler
  async post(url: string, options: RequestOption, ctx?: any): Promise<any> {
    try {
      const session: any | null = await getSession(ctx);
      const accessToken: string | undefined = session?.user?.token;

      // Hard 4s timeout — never let upstream APIs (especially AniList) hang
      // navigation. Caller is expected to handle a null/empty response.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(accessToken &&
              isAnilist(url) && { Authorization: `Bearer ${accessToken}` }),
          },
          ...options,
          signal: controller.signal,
        });

        const data = await response.json();
        return [data, session];
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error: any) {
      handleError(error);
      // Return a safe shape so callers don't crash on undefined destructure.
      return [null, null];
    }
  },
};

function handleError(error: {
  response: { status: any; data: any };
  message: any;
}) {
  console.log(error);
  if (error.response) {
    const { status, data } = error.response;
    switch (status) {
      case 400:
        notify.error("400 Bad request", {
          description: data?.message || error.message,
        });
        break;
      case 401:
        notify.error("401 Unauthorized", {
          description: data?.message || error.message,
        });
        break;
      case 403:
        notify.error("403 Forbidden", {
          description: data?.message || error.message,
        });
        break;
      case 404:
        notify.error(`Resource not found - 404`, {
          description: data?.message || error.message,
        });
        break;
      case 500:
        notify.error("500 Internal server error", {
          description: data?.message || error.message,
        });
        break;
      default:
        notify.error("An error occurred", {
          description: data?.message || error.message,
        });
        break;
    }

    if (data && data.message) {
      console.error("Error message:", data.message);
    }
  }
}

export default pls;
