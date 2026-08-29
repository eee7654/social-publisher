import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetcher } from '@/lib/api-service';

export const ORG_KEYS = {
    all: ['organs'],
    lists: () => [...ORG_KEYS.all, 'list'],
    list: (filters) => [...ORG_KEYS.lists(), filters],
    lookup: () => [...ORG_KEYS.lists()],
    details: () => [...ORG_KEYS.all, 'detail'],
    detail: (id) => [...ORG_KEYS.details(), id],
};

/**
 * هوک دریافت لیست سازمان‌ها (همراه با سرچ و صفحه‌بندی)
 * @param {Object} filters - شامل page, limit, search
 */
export const useList = (filters) => {
    return useQuery({
        queryKey: ORG_KEYS.list(filters),
        queryFn: () => fetcher({
            method: 'GET',
            url: '/api/v1/panel/organs',
            params: filters
        }),
        // نکته: اگر از React Query v5 استفاده می‌کنی، به جای خط زیر بنویس: placeholderData: (prev) => prev
        keepPreviousData: true, 
        staleTime: 5 * 60 * 1000, // دیتا تا ۵ دقیقه Fresh محسوب میشه
    });
};

/**
 * هوک دریافت لیست سازمان‌ها (همراه با سرچ و صفحه‌بندی)
 * @param {Object} filters - شامل page, limit, search
 */
export const useLookup = (filters) => {
    return useQuery({
        queryKey: ORG_KEYS.lookup(),
        queryFn: () => fetcher({
            method: 'GET',
            url: '/api/v1/panel/organs/lookup',
            params: filters
        }),
        keepPreviousData: true, 
        staleTime: 5 * 60 * 1000,
    });
};

/**
 * هوک ایجاد شعبه/سازمان جدید
 */
export const useCreate = () => {
    const queryClient = useQueryClient();
    
    return useMutation({
        mutationFn: (newOrgData) => fetcher({
            method: 'POST',
            url: '/api/v1/panel/organs',
            data: newOrgData
        }),
        onSuccess: () => {
            // 🧹 به محض موفقیت، کشِ لیست رو باطل می‌کنیم تا جدول اتوماتیک رفرش بشه
            queryClient.invalidateQueries({ queryKey: ORG_KEYS.lists() });
        }
    });
};

/**
 * هوک ویرایش اطلاعات پایه شعبه
 */
export const useUpdate = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, ...updateData }) => fetcher({
            method: 'PATCH',
            url: `/api/v1/panel/organs/${id}`,
            data: updateData
        }),
        onSuccess: (_, variables) => {
            // هم لیست رو رفرش می‌کنیم، هم اگر دیتای تکیِ این سازمان جایی باز بود اونم آپدیت میشه
            queryClient.invalidateQueries({ queryKey: ORG_KEYS.lists() });
            queryClient.invalidateQueries({ queryKey: ORG_KEYS.detail(variables.id) });
        }
    });
};

/**
 * هوک تعلیق یا فعال‌سازی مجدد شعبه
 */
export const useSuspend = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, is_active }) => fetcher({
            method: 'PATCH',
            url: `/api/v1/panel/organs/${id}`,
            data: { is_active }
        }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ORG_KEYS.lists() });
        }
    });
};