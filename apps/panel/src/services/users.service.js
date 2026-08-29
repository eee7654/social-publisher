import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetcher } from '@/lib/api-service';

export const USER_KEYS = {
    all: ['users'],
    lists: () => [...USER_KEYS.all, 'list'],
    list: (filters) => [...USER_KEYS.lists(), filters],
    details: () => [...USER_KEYS.all, 'detail'],
    detail: (id) => [...USER_KEYS.details(), id],
};

/**
 * هوک دریافت لیست کاربران
 * @param {Object} filters - شامل page, limit, search, و مهم‌تر از همه: orgId
 */
export const useList = (filters) => {
    return useQuery({
        queryKey: USER_KEYS.list(filters),
        queryFn: () => fetcher({
            method: 'GET',
            url: '/api/v1/panel/users',
            params: filters
        }),
        // برای React Query v5
        placeholderData: (prev) => prev, 
        staleTime: 5 * 60 * 1000,
    });
};


export const useCreate = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (newUserData) => fetcher({
            method: 'POST',
            url: '/api/v1/panel/users',
            data: newUserData
        }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: USER_KEYS.lists() });
        }
    });
};


export const useUpdate = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, ...updateData }) => fetcher({
            method: 'PATCH',
            url: `/api/v1/panel/users/${id}`,
            data: updateData
        }),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({ queryKey: USER_KEYS.lists() });
            queryClient.invalidateQueries({ queryKey: USER_KEYS.detail(variables.id) });
        }
    });
};


export const useSuspend = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, is_active }) => fetcher({
            method: 'PATCH',
            url: `/api/v1/panel/users/${id}`,
            data: { is_active }
        }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: USER_KEYS.lists() });
        }
    });
};