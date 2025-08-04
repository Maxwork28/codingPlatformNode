def findMax(arr):
    max_element = arr[0]  # Initialize with first element
    for num in arr:
        if num > max_element:
            max_element = num
    return max_element